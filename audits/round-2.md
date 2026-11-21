# Guardrail security review, round 2 (Nov 21 2026)

**Scope.** I reviewed `git diff 755c800..HEAD -- programs/` in `solana/guardrail`, with HEAD at 34c3902. That range
covers:
- the F1 to F4 fixes
- the post-CPI stored-order check
- `max_order_lifetime_secs`
- placed-order slots with pruning
- `OrderNotStored`
- G10 (`set_daily_loss`, the day baseline, the deposit and withdraw adjustment)
- the R8 change (2cfe07d: G4, G5 and G10 apply only to orders that raise worst-case exposure)

The threat model is unchanged: the agent is untrusted, the owner is trusted.

**Method.**
- I exported HEAD with `git archive` into a temporary directory, with build caches cloned copy-on-write.
- I rebuilt `guard.so` there. It is byte-identical to the repo's current `target/deploy/guard.so` (sha256 66e21057...3e7b).
- The repo's suites pass on it.
- I ran 8 REPLAY probes (`r2probe.rs`) on Velocity's real devnet binary. Key code is in the appendix.
- The repo was never written to. The temporary copy is deleted.

Line numbers below are HEAD 34c3902 `programs/guard/src/lib.rs`.

---

## N1 (High, CONFIRMED with fills): the R8 "not increasing" rule lets the agent flip a position past flat with G10 tripped and G5 over the cap

**Where.**
- `lib.rs:641-643`: `increases = worst_case_after > worst_case_base`, computed at `:643`.
- G10 (`:666`), G4 (`:685`) and G5 (`:690-706`) are skipped when it is false.

**Root cause.** Worst case is `max(|base + bids|, |base + asks|)`. An order on the smaller side does not raise the max.
On a long of 5 with no open orders, the worst case is 5, so sells totalling up to 10 count as "not increasing". If they
fill, the account is short 5: a brand-new position.

**Probe `q3_flip_bypasses_g10_and_g5`.** Setup: 1,000 dUSDT, long 5 SOL, G10 cap 20 dUSDT, G1 5 SOL, G5 0.4x (already
over the cap).
1. The price drops 5%. A risk-increasing bid is refused by G10 (loss 22.85 dUSDT).
2. The agent then places two plain SELL 5 orders. Both are accepted (rule 0).
3. Flow fills them. The position goes from +5 to **-5**.
4. Next round, two plain BUY 5 orders are accepted. They fill and the position flips back to **+5**. Meanwhile G10 refuses
   only the orders that do raise the max.

`refused_g10` stays at the refusals of raising orders, while each flip opens a fresh full-size position after the daily
loss cap has tripped. G1 is no barrier, because two orders of |position| each do the same job. The same path also skips
G5's fail-closed cases (OtherSpotBalance, NonPositiveEquity).

**Impact.** Against a tripped G10 or an over-cap G5, the agent keeps taking new directional risk of the position's full
size indefinitely, and losses keep growing past the daily cap.

**Test coverage.** The R8 test (audit.rs:361) refuses a 20 SOL sell only because a 5 SOL sell already rests (asks -5).
With no resting asks, the same 2x sell passes.

**Fix.** Treat an order as non-increasing only if it cannot carry the position past flat: it is opposite to the
position, and `size + all open orders on that side <= |base|`. Otherwise apply G4, G5 and G10. Add a test: long 10,
with no resting orders, a plain SELL 20 (or two SELL 10) is refused when G10 has tripped.

## N2 (Medium, CONFIRMED): the agent chooses when the G10 baseline is taken, so losses before its first call of the day are never counted

**Where.**
- `take_day_baseline` (`lib.rs:502-524`) runs only inside agent calls.
- `check_order` (`:646-669`) also sets it, but only on the agent's orders.
- Nothing else takes a baseline.

**Probe `q1_baseline_timing`.** Setup: long 5 SOL, cap 20 dUSDT, then a new UTC day.
- **Twin.** The first call is at the open (baseline 1,000.54). The price falls 5%, and a bid is refused by G10 with a loss
  of 22.85.
- **Attack.** The agent makes no call at the open. The price falls 5%, and the agent's first call is a bid at the low.
  - The baseline is set at 977.69 and the bid is accepted.
  - A further ~4% drop still leaves bids accepted.
  - The 22.85 dUSDT lost before the first call (more than the whole cap) is invisible.

**Forcing skips.**
- Not needed: idling is enough.
- A refused `cancel_order(None)` with no remaining accounts succeeds and takes no baseline (confirmed). This is harmless
  on its own.
- An exit with SPOT0 omitted fails inside Velocity (SpotMarketNotFound, 6087), so exits cannot be used to trade while
  dodging the baseline.
- Any accepted risk order needs every price fresh, so it always sets the baseline (`:646-669`). The agent therefore
  cannot trade new risk before choosing its baseline. It can only choose by waiting.

**Impact.** The effective daily loss is the cap plus whatever the held position lost before the agent's first call.
Losses across midnight are never counted on either day.

**Fix (both parts).**
- Store the equity and flows at every guard call. On a new day, use `max(equity now, last observed equity + flow delta)`
  as the baseline.
- Add a permissionless `checkpoint` instruction (owner cron or any keeper) that takes the baseline with fresh prices.

## N3 (Medium, CONFIRMED with a fill): exits are exempt from `max_order_lifetime_secs`, so a resting exit at the band edge is picked off after the price moves

**Where.**
- The exit path returns at `lib.rs:585`, before the lifetime pre-check (`:605-616`).
- `stored_order_check` skips lifetime for `Outcome::Exit` (`:355`).

**Probe `q4_exit_has_no_lifetime_and_is_picked_off`.** Setup: lifetime cap 60 s, 1% band.
1. An entry without `max_ts` is refused (6030), which is correct.
2. A reduce-only SELL 1 @ 92.00 (in band) with no `max_ts` is accepted as G9 and stored with `max_ts 0` (never expires).
3. A day later the oracle is 100.53. A partner takes it with `place_and_take` at 92.00. The owner sold 1 SOL for
   92,017,258 quote, 8.5% under the oracle.

The lifetime cap exists to stop exactly this (round-1 F5), and exits reopen it. Exits need no position-size room, so
the agent can park one for the full position at the favourable band edge and wait.

**Fix.** Apply the lifetime bound to exits, both pre-check and stored. An exit can always be re-placed, so this never
traps a position.

## N4 (Medium, CONFIRMED): honest exits can still be trapped

**Q3 answer.** At HEAD, a plain risk-reducing sell passes once leverage has drifted over the cap (R8). But that same
rule causes N1. The remaining traps:

**(a) The owner's own reduce-only orders use up the agent's G9 allowance.**
- `resting_reduce_only` (`velocity.rs`, used at `lib.rs:564`) sums every open reduce-only order, including the
  owner's, which the agent may not cancel.
- Probe `q3_exit_traps`: the owner rests a reduce-only take-profit for the full position and pauses. The agent's exit
  of the full size, and even of half, falls out of G9 and is refused by G7.
- Unpaused, the same exit takes the normal path, where G3 (daily notional spent), G1 or the lifetime rule can refuse it.
- Untriggered owner trigger orders are probably counted too, since their status is Open (UNCONFIRMED).
- Fix: count only guard-placed ids (`placed_order_ids`). Velocity clamps fills anyway.

**(b) Removing a market from the allowlist strands the position.**
- Since the F2 fix, exits keep G2 (`:566-572`). After the owner delists market 0, the agent's exit is refused by G2
  (6001, confirmed).
- This is an owner action, so it is a design choice to document. The spec still says a guard must never trap an agent.
- Fix: keep the order-type check for exits, but allow exits on markets where a position exists.

**Other honest-exit refusals.**
- G6 band and stale-exit rules (by design).
- `TooManyOpenOrders` when 32 guard orders are live (cancel first).
- OrderNotStored when Velocity skips the order.

## N5 (Low, CONFIRMED): F4 is fixed only on the G9 path

**Probe `q2_f4_rerun_unpaused`.**
- While not paused, the 2nd and 3rd reduce-only SELL 1 against a 1 SOL position leave G9 but are accepted on the normal
  path as "not increasing" (rule 0).
- The keeper then cancels each surplus order for +10,000 quote, paid by the owner (`audit-f4` numbers match round 1).
- Now bounded by G3 (each counts notional: `day_notional` 274.17 dUSDT for three 1 SOL orders), and by lifetime when
  set.
- Fix: the N1 fix also covers this (size + same-side open orders <= |base|).

## Fixes confirmed (Q2)

- **F1.** Refused, for both entry and exit:
  - Oracle BUY with no offset, with or without auction params: refused G6 (6007).
  - The same as a reduce-only exit while paused: refused G6.
  - Stale Limit exit with price 0: refused (6028).
  - The stored-order check also covers Velocity-generated auctions (unit test `audit_stored_orders`).
- **F2.** An Oracle exit under a LIMIT-only allowlist is refused by G2 (6002).
- **F3.** The agent cancelling the owner's order by id, or with None, is refused and recorded (`refused_cancels` 2). The
  owner's order stays.
- **F4.** Fixed on the G9 path. Not fixed on the normal path (N5).

## Q4 notes on prune, slots, lifetime and the post-CPI check (no bypass found)

- **Prune and slots.** Placed ids are pruned against Velocity's open orders on every place. Velocity order ids are
  monotonic, so a stale placed id never matches an owner order. Cancelling a stale id is a harmless no-op in Velocity.
  `record_placed` fails rather than evicting. No panics: every `unwrap` follows a check, indices are clamped, and
  counters use checked arithmetic in release.
- **Velocity keeps `max_ts`.** A Market order with `max_ts` now+30 is stored with that `max_ts`, so the stored lifetime
  check does not falsely fail Market orders.
- **Stored-order check.** It reads only orders new to this call, against the same market accounts. It fails the
  transaction, so a skipped or rewritten order cannot be counted.
- **Owner DoS (Low, reasoning only).**
  - Exits have no lifetime (N3) and need only `size + resting <= |position|`.
  - So the agent can fill Velocity's 32 order slots with tiny resting exits, and the owner's own placements then fail
    until the owner cancels directly.
  - The N3 fix bounds this.
- **G10 details (Info).**
  - `total_deposits` and `total_withdraws` are valued at the quote oracle, while collateral is counted 1:1. A deposit
    made while the quote oracle is off $1 shows as a small gain or loss.
  - `baseline_equity == 0` is used as "no baseline", so an account whose equity is exactly 0 re-baselines on every call.

## Uncommitted state at review time

The working tree had `demo/quickstart.mjs` untracked; no program changes beyond HEAD.

## Appendix: probe code (r2probe.rs, uses the repo's tests-litesvm harness)

```rust
fn setup_with(dusdt: u64, l: Limits) -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(dusdt, l);
    env.step(2, P0);
    (env, g)
}
fn tight() -> Limits {
    let mut l = Limits::loose();
    l.price_band_bps = 100;
    l
}
fn ev(r: &TxResult) -> String {
    format!("ok={} ev={:?}", r.is_ok(), events(r).first().map(|e| (e.accepted, e.rule, e.reason, e.value)))
}
fn open(env: &mut Env, g: &Guarded, dir: u8, size: u64) {
    let flow = env.trader("flow", 1_000_000);
    let px = if dir == 0 { 91_300_000 } else { 91_500_000 };
    assert_ok(&env.gplace("agent opens", g, Order::resting(dir, size, px)));
    env.step(2, P0);
    let got = env.cross("flow crosses", &flow, g, 1 - dir, 1_000 * BASE, px);
    assert_eq!(got.unsigned_abs(), size);
    env.step(2, P0);
}
fn raw_ix(g: &Guarded, name: &str, args: Vec<u8>, remaining: Vec<AccountMeta>) -> Instruction {
    let mut data = disc(name).to_vec();
    data.extend(args);
    let mut accounts = vec![
        AccountMeta::new_readonly(g.agent.pubkey(), true),
        AccountMeta::new(g.guard, false),
        AccountMeta::new_readonly(STATE, false),
        AccountMeta::new(g.user, false),
        AccountMeta::new_readonly(VELOCITY, false),
    ];
    accounts.extend(remaining);
    Instruction { program_id: GUARD, accounts, data }
}
fn g10_setup() -> (Env, Guarded) {
    let (mut env, g) = setup_with(1_000, Limits::loose());
    open(&mut env, &g, 0, 5 * BASE);
    let ok = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("cap 20", &g, &ok, 20 * QUOTE));
    (env, g)
}
fn small_bid(px: u64) -> Order {
    Order::resting(0, BASE / 10, px - 10_000)
}

fn q3_flip_bypasses_g10_and_g5() {
    let (mut env, g) = g10_setup(); // 1,000 dUSDT, long 5 SOL, cap 20
    let owner = g.owner.pubkey();
    let ok = g.owner.insecure_clone();
    let mut l = Limits::loose();
    l.max_order_base = 5 * BASE; // G1: no single order above the position size
    l.max_leverage_bps = 4_000; // 0.4x: the 5 SOL long (~0.46x) is already over the cap
    assert_ok(&env.set_limits("owner: G1 5 SOL, G5 0.4x", &g, &ok, &l));
    let r = env.gplace("first bid of the day (baseline)", &g, small_bid(P0));
    env.note(format!("baseline call {}", ev(&r)));
    let p1 = (P0 as f64 * 0.95) as u64;
    env.step(5, p1);
    let r = env.gplace("a risky bid after a 5% drop", &g, small_bid(p1));
    env.note(format!("bid after drop (G10 should refuse) {}", ev(&r)));
    let _ = env.gcancel_raw(&ok); // owner clears the resting bids so totals are clean
    let flow = env.trader("flow2", 1_000_000);
    let mut price = p1;
    for round in 0..4 {
        let pos = env.totals(&owner).0;
        let dir = if pos > 0 { 1u8 } else { 0u8 };
        let px = if dir == 1 { price + 50_000 } else { price - 50_000 };
        for k in 0..2 {
            let mut o = Order::resting(dir, 5 * BASE, px);
            o.user_order_id = (round * 2 + k) as u8 + 1;
            let r = env.gplace(&format!("round {round}: plain {} 5 SOL #{k}", if dir == 1 { "SELL" } else { "BUY" }), &g, o);
            env.note(format!("round {round} order {k} {}", ev(&r)));
        }
        env.step(2, price);
        let got = env.cross("flow crosses both", &flow, &g, 1 - dir, 1_000 * BASE, px);
        let st = env.guard_state(&g);
        env.note(format!("round {round}: filled {got}, position now {:?}, refused_g10 {}, refused_g5 {}", env.totals(&owner), st.refused_g10, st.refused[5]));
        price = if round % 2 == 0 { (price as f64 * 1.01) as u64 } else { (price as f64 * 0.99) as u64 };
        env.step(2, price);
    }
    log(&env, "q3-flip");
}

fn q1_baseline_timing() {
    let p_low = (P0 as f64 * 0.95) as u64;
    // twin
    let (mut env, g) = g10_setup();
    env.step(DAY_SLOTS, P0);
    let r = env.gplace("twin: first call at the open", &g, small_bid(P0));
    env.note(format!("twin open {} baseline {}", ev(&r), env.guard_state(&g).baseline_equity));
    env.step(5, p_low);
    let r = env.gplace("twin: bid after 5% drop", &g, small_bid(p_low));
    env.note(format!("twin after drop {}", ev(&r)));
    log(&env, "q1-twin");
    // attack
    let (mut env, g) = g10_setup();
    env.step(DAY_SLOTS, P0);
    let st0 = env.guard_state(&g);
    // a refused cancel with NO remaining accounts: succeeds, takes no baseline
    let ix = raw_ix(&g, "cancel_order", vec![0], vec![]);
    let agent = g.agent.insecure_clone();
    let r = env.send("cancel(None) with no remaining accounts", vec![ix], &[&agent]);
    let st1 = env.guard_state(&g);
    env.note(format!("empty cancel ok={} loss_day {} -> {}, baseline {} -> {}", r.is_ok(), st0.loss_day, st1.loss_day, st0.baseline_equity, st1.baseline_equity));
    // an exit with SPOT0 omitted from the remaining accounts
    let mut exit = Order::resting(1, BASE, P0 + 20_000);
    exit.reduce_only = true;
    let r = env.gplace_as("exit with spot0 omitted", &g, &agent, exit, &[
        AccountMeta::new_readonly(SOL_ORACLE, false),
        AccountMeta::new_readonly(USDT_ORACLE, false),
        AccountMeta::new(PERP0, false),
    ]);
    let st2 = env.guard_state(&g);
    env.note(format!("exit without spot0 {} baseline {} (day {})", ev(&r), st2.baseline_equity, st2.loss_day));
    env.step(5, p_low);
    let r = env.gplace("attack: first risk call after the 5% drop", &g, small_bid(p_low));
    let st3 = env.guard_state(&g);
    env.note(format!("attack after drop {} baseline {}", ev(&r), st3.baseline_equity));
    // headroom: a further loss up to 20 still passes
    let p_lower = (P0 as f64 * 0.953 * 0.96) as u64;
    env.step(5, p_lower);
    let r = env.gplace("attack: bid after a further ~4% drop", &g, small_bid(p_lower));
    env.note(format!("attack further {}", ev(&r)));
    log(&env, "q1-attack");
}

fn q4_exit_has_no_lifetime_and_is_picked_off() {
    let mut l = tight();
    l.max_order_lifetime_secs = 60;
    let (mut env, g) = setup_with(10_000, l);
    let owner = g.owner.pubkey();
    // open long 1 with a lifetime-bounded bid
    let flow = env.trader("flow", 1_000_000);
    let mut bid = Order::resting(0, BASE, 91_300_000);
    bid.max_ts = Some(env.now() + 30);
    assert_ok(&env.gplace("bid with max_ts", &g, bid));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, 91_300_000);
    env.step(2, P0);
    let mut nolife = Order::resting(0, BASE / 10, 91_000_000);
    nolife.max_ts = None;
    let r = env.gplace("entry without max_ts", &g, nolife);
    env.note(format!("entry without max_ts {}", ev(&r)));
    let mut exit = Order::resting(1, BASE, 92_000_000); // 0.67% over the oracle: inside the band
    exit.reduce_only = true;
    let r = env.gplace("exit SELL @ 92.00, no max_ts", &g, exit);
    env.note(format!("exit {} stored {:?}", ev(&r), raw_orders(&env, &owner)));
    // a day later the price is 10% higher; the exit still rests
    let p1 = 100_530_000;
    env.step(DAY_SLOTS, p1);
    let partner = env.trader("partner", 100_000);
    let ob = env.totals(&owner);
    let r = env.place_and_take("partner BUY 1 @ 92.00 with owner as maker", &partner, Order::limit(0, BASE, 92_000_000), &[&owner]);
    let oa = env.totals(&owner);
    env.note(format!("pick-off ok={} owner before {:?} after {:?}: sold {} for {} quote, oracle {}", r.is_ok(), ob, oa, ob.0 - oa.0, oa.1 - ob.1, p1));
    log(&env, "q4-lifetime");
}
```
