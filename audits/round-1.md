# Guardrail security review, Nov 21 2026

Scope: `solana/guardrail` (`programs/guard/src/lib.rs`, `math.rs`, `velocity.rs`, SPEC.md, tests-litesvm). I reviewed
it at 3802f57. HEAD is now 755c800, and `programs/` there is byte-identical to what I tested, so the line numbers below
hold.
Threat model: the agent key is untrusted, the owner is trusted.

Method: I read the code and checked every Velocity layout offset against the IDL with a layout calculator. All offsets
match: PerpMarket oracle 312, market_index 640, oracle_source 673; SpotMarket deposit interest 328, borrow interest 344,
decimals 696, market_index 700; User spot 104, perp 424, orders 1064; PerpPosition market_index +76, open_orders +78.

To confirm findings, I ran REPLAY probes on Velocity's real devnet binary in LiteSVM. They ran in a copy-on-write clone
at a temporary directory, never in the repo:
- Probe file: `tests-litesvm/tests/audit.rs`. The key parts are in the appendix.
- Logs: `out/audit-*.txt`.
- Baseline: the repo's own `limits` suite passed 46/46 against the same `guard.so` (sha256 1d8b3d2c...86ae) before I
  added the probes.

Prices below are in USD per SOL, with the oracle at 91.39 and a guard band of 100 bps (1%).

---

## F1 (High, CONFIRMED with fills): an Oracle order with no offset has no worst price, so G6 is bypassed, including on exits while paused

**Where**
- `lib.rs:172` refuses only `MARKET` orders with `price == 0`.
- `lib.rs:178-181` skips the offset check when the offset is `None` or 0.
- `lib.rs:201` explicitly exempts `ORACLE` from the stale-exit "missing price" rule.

**What Velocity does.** Velocity rejects any Oracle order that carries a price ("Oracle order can not have a price",
error 6191, seen in the probe). So for an Oracle order, `oracle_price_offset` is the only limit price. If the offset is
0, Velocity stores `price 0, oracle_price_offset 0`. After the auction, the order is a market order with no limit.

**Attack A (needs ORACLE in `allowed_order_types`)**
- The agent sends `order_type 4, price 0, oracle_price_offset None, auction (10, 0, 0)`. Every field it sends is inside
  the band, so the guard accepts it (rule 0).
- A partner account rests an ask at 97.80, which is 7% above the oracle.
- After 20 slots, anyone calls `fill_perp_order`.
- Result (`audit-a1.txt`): the owner's base goes up by 1.0 SOL and quote goes down by 97,897,800. The owner paid
  $97.90 per SOL, 7.1% above the oracle and 7 times the band. (The log's "avg price 0.0001" line has a formula bug in
  my probe. The base and quote deltas are the evidence.)
- Twin with `oracle_price_offset +0.50` (in band): Velocity logs "taker does not cross amm: taker price 91890000" and
  does not fill (`audit-a5.txt`).

**Same order with no auction params (`audit-a1b.txt`).** Velocity writes its own auction: relative +0.72 rising to
+15.29 over 180 slots. That is up to 16.7% above the oracle during the auction, then no limit afterwards. The guard
never sees these generated prices.

**Attack B (works on any owner config, while paused, with a stale oracle)**
- Owner settings: allowlist LIMIT only, paused, `exit_max_staleness_slots 10`.
- The agent sends a reduce-only Oracle SELL of the full position with no offset. The guard accepts it as a G9 exit
  (rule 9) in both cases: fresh oracle, and oracle 50 slots old (`audit-a2.txt`).
- Far fill on the exit path, short side (`audit-a2c.txt`):
  - Setup: short 1 SOL, paused, LIMIT-only, 1% band. A partner rests an ask at 97.80.
  - The agent sends a reduce-only Oracle BUY 1 with no offset. The guard accepts it (rule 9).
  - After 20 slots, the keeper fills it against the partner. The owner bought 1 SOL for 97,896,658 quote, which is
    $97.90 per SOL and 7.1% above the oracle. The partner's quote rose to 97,819,560.
- Long side (`audit-a2b-*.txt`):
  - The same exit as a SELL filled for +90,293,904 quote, about 90.38 before the 0.1% fee and roughly 1.1% under the
    oracle.
  - Something better than the partner's 85.00 bid filled it first. That this was the AMM is my inference.
  - In the stale case, I refreshed the oracle before the fill, because Velocity needs a fresh oracle to fill. The guard
    acceptance itself happened on the 50-slot-old oracle.

**Bound.** The value the agent can hand to a colluding counterparty per order is size x distance, capped only by
Velocity's own fill checks:
- Entries are capped by G1, G3, G4 and G5.
- Exits have no count limit and are allowed while paused.

**Test coverage.** None.
- `g6_refuses_oracle_order_with_a_far_price_field` (limits.rs:701): its accepted twin carries offset -0.50.
- `stale_exit_refuses_market_without_price_negative_offset_and_unfavourable_auction` (limits.rs:947) refuses an Oracle
  SELL with a negative offset but never tries one with no offset, which is the worse case.

**Fix**
- In `band_breach`, refuse `ORACLE` when the offset is `None` or 0.
- In `unfavourable_for_stale_exit`, remove the ORACLE exemption at line 201 and require an offset on the
  owner-favourable side.
- Stronger: after the CPI, read the stored order (User + 1064 + i*104: price +8, auction start +48, auction end +56,
  offset +72, duration +96) and assert that every price is in band. This also catches auction prices that Velocity
  generates itself.

## F2 (Medium, CONFIRMED): G9 exits skip the whole G2 allowlist, including the order-type allowlist

**Where.** `lib.rs:353-366` returns `Outcome::Exit` before the market and order-type checks at `lib.rs:374-380`.

**Spec gap.** SPEC G9 says exits skip "pause and caps G1/G3/G4/G5". Skipping the market allowlist is intended and tested
(limits.rs:530, for delisted markets). Skipping the order-type allowlist is neither specified nor tested.

**Attack**
- Order types: `audit-a2.txt` shows an Oracle exit accepted while the owner allows LIMIT only. This is what makes F1
  attack B work on every guard.
- Markets: the agent can also close positions the owner opened directly in markets the agent was never allowed to
  trade. For example, it can close the owner's hedge in market 1 with a reduce-only order inside the band.

**Fix.** Apply the order-type allowlist to exits. At minimum, allow only LIMIT exits, or Oracle exits with an offset.
Decide whether the agent may close positions in markets that were never allowlisted.

## F3 (Medium, CONFIRMED): the agent can cancel the owner's own orders, and nothing is recorded

**Where.** `lib.rs:134-143` forwards any `order_id`, including `None`, with no event and no counter.

**Attack (`audit-a3.txt`)**
- The owner places two orders directly on Velocity.
- The agent cancels id 1 through the guard, then sends `None`, which cancels the other.
- Both transactions succeed with zero `OrderChecked` events. `accepted_count` and every refusal counter are unchanged.

**Impact.** A compromised agent can silently strip the owner's protective orders, such as a stop the owner placed
directly. The dashboard decodes only `OrderChecked` events (`dashboard/guard-view.js:5,68`), so it shows nothing.

**Test coverage.** `g7_pause_blocks_new_orders_but_not_cancels` (limits.rs:423-440) cancels only an order the agent
itself placed.

**Fix**
- Emit an event for every cancel.
- To limit cancels to guard-placed orders, force `user_order_id` into a reserved tag range on every placement. Then
  allow cancels only of orders whose slot (`+89`) carries that tag. The guard can read the order slots before the CPI.

## F4 (Low, CONFIRMED): unfillable stacked exits cost the owner a filler reward on every cycle

**Where.** `math.rs:71-77` (`is_exit`) compares the order size only with the current position, ignoring resting exits.
Exits skip G3 and the pause.

**Attack (`audit-a4.txt`)**
- Position long 1. The agent places three reduce-only SELL 1 orders, and each is accepted as G9.
- The keeper fills the first one: the position goes to 0. Good: Velocity clamps, so the position never flips.
- Filling each of the other two cancels it and debits the owner's quote by 10,000 (0.01 dUSDT) each.
- The keeper's perp quote rises by exactly 10,000 per cancel (`audit-a4.txt`). So the filler is paid, and the filler
  can be the agent's own keeper.
- Bound:
  - `is_exit` needs a non-zero position (`math.rs:72`), and Velocity has 32 order slots, so this is at most about 31
    surplus exits (about 0.31 dUSDT) per position close.
  - Repeating it needs a new position, and opening one goes through G1, G3, G4 and G5.
  - Small, but it is a flow of the owner's funds that the agent controls.

**Fix.** Refuse an exit when this order plus the open reduce-only orders on the same side (read from the 32 order
slots, `reduce_only` at +92) exceeds |position|.

## F5 (Info / design): G6 is checked only when an order is placed

A resting limit order with `max_ts None` stays live after the oracle moves, and it fills at its stale price. The guard
never inspects `max_ts`. The loss is bounded by G4/G5, not by the band.

**Fix.** Require `max_ts <= now + N` on non-exit orders, or steer the agent to Oracle orders with an offset.

## Other notes (Info)

- **Band leakage, quantified.** Inside the band, a round trip (buy at +band, sell at -band) moves up to 2 x band x
  notional to a partner. Only the entry counts toward G3. So the per-day leak is at most about 2 x `price_band_bps`/10,000
  x `daily_notional_cap` (with 100 bps and a 100k cap, about 2k per day). This is a limit of the design, not a bug.
- **Staleness uses `posted_slot`** (`lib.rs:272`), not `publish_time` against the clock. If Velocity's
  `post_pyth_lazer_oracle_update` accepts an old signed message that is newer than the stored one, a quiet oracle can be
  re-posted with a fresh slot and an old price. UNCONFIRMED: I had no signed Lazer message to test with. Velocity
  itself measures delay the same way.
- **G5 equity** (`lib.rs:318-320`) counts full unrealized PnL, unweighted, and ignores unsettled funding. Leverage can
  read lower than Velocity's own margin view would.
- **G3** counts notional at the oracle, not at the order price, so it can understate by up to the band. It also counts
  at placement time, so orders placed late on one UTC day and early on the next both fill inside a short window.
- **`last_refusal`** (`lib.rs:105`) is overwritten by every refusal. The agent can bury a meaningful refusal under
  deliberate benign ones. The counters stay exact and the events persist.
- **Rounding.** `notional` truncates toward zero. For a short, unrealized PnL rounds up by less than 1e-6 quote per
  market. Leverage rounds up. Negligible.
- **Overflow.** Overflow is not a concern: math runs in i128, `overflow-checks = true` in release, and the only i64
  addition is in `perp_totals`, which overflows only with duplicate slots for one market (Velocity does not create
  them).

## Checked and sound

- **Account substitution**
  - PerpMarket: PDA address, owner, discriminator, size and market index are all checked
    (`velocity.rs:165-177`).
  - Oracle: the key must equal `pm.oracle` and be owned by Velocity (`lib.rs:269-270`). A look-alike is refused
    (existing test, limits.rs:305).
  - SpotMarket 0: PDA, owner and discriminator are checked.
  - User: bound by `has_one`, with owner and discriminator checked.
  - Program address: fixed.
  - `velocity_state`: unchecked by the guard, but Velocity loads it as `Account<State>`, and only one State exists.
  - Remaining accounts are forwarded unchanged. The guard reads only the accounts it locates by derived key, so extra
    or reordered accounts cannot change what it reads.
- **Stacked exits.** Velocity clamps reduce-only fills to the position on the maker side (repo probe C/D) and the taker
  side (A4). Stacked exits cannot flip or grow a position; they only add the F4 fee.
- **G4 formula.** It matches a brute-force check (existing proptest) and counts reduce-only orders, which is
  conservative. Fills cannot raise base + bids or base + asks.
- **Market auctions.** For a Market order with an in-band price and no auction params, Velocity's generated auction
  (92.11 to 92.30) stays in band (`audit-a1b.txt`).
- **Oracle exponent** (`math.rs:7-18`):
  - A non-positive price or an exponent outside -18..18 returns None, which makes the transaction fail.
  - The scaling is exact. With the Lazer -8 exponent it truncates by under 1e-6.
  - Only the PythLazer source (12) is accepted, so the 1K/1M-multiplier sources cannot be misread.
- **Order fields the guard does not inspect**, with a verdict for each:
  - `post_only`: owner-favourable or neutral. Slide only moves the price less aggressive, and the clamp still applies
    (repo probe C/D).
  - `user_order_id`: harmless (it is the F3 fix lever).
  - `auction_duration`: harmless once the prices are banded. For Market orders without auction params, Velocity's
    generated auction stays in band. The exception is F1: Oracle orders without auction params get Velocity's own wide
    auction.
  - `trigger_condition`: harmless, because trigger orders and `trigger_price` are refused (`lib.rs:340`).
  - `max_ts`: see F5. It is also unbounded the other way: a past or short `max_ts` makes an order expire, and an expired
    order earns a filler the same cancel reward as F4 (UNCONFIRMED for the expiry path).
- **G3 rollover** (`lib.rs:413-418`): `utc_day` uses `div_euclid`. `used` resets when `g.day != day`, and `g.day` is
  written only on an accepted entry. Exits and refusals do not touch it. No double counting or negative notional:
  `base_asset_amount` is u64 and nonzero, and notional uses its absolute value.
- **G5 with zero collateral or negative equity**: `leverage_bps` returns None, so the order is refused with
  NonPositiveEquity (existing test, limits.rs:776). Negative uPnL is included (existing test, limits.rs:264).
- **PDA seeds.** `[b"guard", user]` cannot collide, and init requires the User authority.
- **CPI.** Account order is `[state, user (w), guard (signer)] + remaining`, which matches the IDL. The guard PDA can sign
  only the two fixed discriminators.

## Appendix: F1 probes (from audit.rs; they use the repo's tests-litesvm harness)

Add these to a file under `tests-litesvm/tests/` with `use guardrail_tests::*; use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair; use solana_signer::Signer; const P0: u64 = 91_390_000;`, plus a `setup(l)` like limits.rs
(10,000 dUSDT). `raw_orders` reads the User order slots (User + 1064 + i*104; price +8, auction start +48, end +56,
offset +72, order_id +80, status +86, type +87, reduce_only +92, duration +96). `write_log` writes `env.log` to `out/`.

```rust
fn fill(env: &mut Env, label: &str, filler: &Keypair, taker_owner: &Pubkey, order_id: u32, makers: &[&Pubkey]) -> TxResult {
    let mut data = disc("fill_perp_order").to_vec();
    data.push(1);
    data.extend_from_slice(&order_id.to_le_bytes());
    data.push(0);
    let f = filler.pubkey();
    let mut accounts = vec![
        AccountMeta::new_readonly(STATE, false),
        AccountMeta::new_readonly(f, true),
        AccountMeta::new(user_pda(&f), false),
        AccountMeta::new(stats_pda(&f), false),
        AccountMeta::new(user_pda(taker_owner), false),
        AccountMeta::new(stats_pda(taker_owner), false),
    ];
    accounts.extend(Env::maps());
    for m in makers {
        accounts.push(AccountMeta::new(user_pda(m), false));
        accounts.push(AccountMeta::new(stats_pda(m), false));
    }
    env.send(label, vec![Instruction { program_id: VELOCITY, accounts, data }], &[filler])
}

fn tight() -> Limits {
    let mut l = Limits::loose();
    l.price_band_bps = 100; // 1%
    l
}

fn oracle_no_limit(direction: u8) -> Order {
    let mut o = Order::limit(direction, BASE, 0);
    o.order_type = 4; // Oracle
    o.auction = Some((10, 0, 0)); // relative 0: at the oracle, inside the band
    o
}

/// A2c: exit path, short position: reduce-only Oracle BUY with no offset (paused, LIMIT-only, 1% band) fills into a
/// partner's ask 7% above the oracle.
#[test]
fn a2c_exit_oracle_no_limit_short_fills_far_above() {
    let mut l = tight();
    l.max_oracle_staleness_slots = 3;
    l.exit_max_staleness_slots = 10;
    let (mut env, g) = setup(l);
    let owner = g.owner.pubkey();
    let ok = g.owner.insecure_clone();
    let flow = env.trader("flow", 1_000_000);
    let partner = env.trader("partner", 100_000);
    let keeper = env.trader("keeper", 1_000);
    assert_ok(&env.gplace("agent ask to open a short", &g, Order::resting(1, BASE, 91_500_000)));
    env.step(2, P0);
    let got = env.cross("flow buys the ask", &flow, &g, 0, 1_000 * BASE, 91_500_000);
    env.note(format!("opened {got}"));
    env.step(2, P0);
    let mut l2 = l;
    l2.allowed_order_types = 1 << 1;
    assert_ok(&env.set_limits("owner: LIMIT only", &g, &ok, &l2));
    assert_ok(&env.set_paused("owner pauses", &g, &ok, true));
    assert_ok(&env.place("partner rests SELL 1 @ 97.80 (+7%)", &partner, Order::resting(1, BASE, 97_800_000)));
    env.step(1, P0);
    let mut e = oracle_no_limit(0);
    e.reduce_only = true;
    let r = env.gplace("agent Oracle reduce-only BUY 1, no offset (paused, LIMIT-only)", &g, e);
    env.note(format!("exit ok={} ev={:?} stored {:?}", r.is_ok(), events(&r).first().map(|e| (e.accepted, e.rule)), raw_orders(&env, &owner)));
    let before = env.totals(&owner);
    env.step(20, P0);
    let id = raw_orders(&env, &owner).last().map(|o| o.order_id).unwrap_or(0);
    let pp = partner.pubkey();
    let pb = env.totals(&pp);
    let r = fill(&mut env, "keeper fills the exit against the +7% ask", &keeper, &owner, id, &[&pp]);
    let after = env.totals(&owner);
    env.note(format!("fill ok={} owner before={:?} after={:?} => bought {} base for {} quote; partner before {:?} after {:?}", r.is_ok(), before, after, after.0 - before.0, after.1 - before.1, pb, env.totals(&pp)));
    write_log(&env, "audit-a2c");
}
```
