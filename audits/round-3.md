# Guardrail security review, round 3 (Nov 21 2026)

## Scope and method

**What I reviewed.** The program delta from the R8 commit (round-2 HEAD, now rewritten as 3220d36) to HEAD 543add8.
Program code there is identical to 59a98f8, which already includes the owner/keeper-only midnight mark and the
"state errors skip the observation" change. The delta covers:
- the true-exit rule (N1)
- `last_seen_equity` with the max baseline, and the checkpoint (N2)
- strict observation
- lifetime on exits (N3)
- guard-own resting exits (N4)
- ReduceOnlyBeyondPosition (N5)
- `set_keeper`

**How I tested.**
- I exported HEAD into a temporary directory with build caches cloned copy-on-write.
- `guard.so` rebuilt byte-identical to the repo's, and to the devnet hash in `notes/devnet-guard-so.sha256` (064ea026...1191).
- Every repo suite passes on it.
- I also rebuilt the 3ca9666 and 3220d36 binaries; their hashes match the ones from round 2.
- 7 REPLAY probes (`r3probe.rs`) ran on Velocity's real devnet binary.
- Two read-only `simulateTransaction` calls ran against devnet. No transaction was sent.
- The repo was never written to, and the temporary copy is deleted.

Line numbers are HEAD `programs/guard/src/lib.rs`.

---

## R3-1 (Medium, CONFIRMED on live devnet): every Guard field append bricks the existing guards for good; 10 of the 11 devnet guards, including the dashboard default, no longer load

**Where**
- `Guard` grew by 17 bytes (`last_seen_*`, `has_last_seen`) and then by 32 bytes (`keeper`, `lib.rs:922`).
- `Account<'info, Guard>` deserializes the full struct, so a guard created under an earlier layout fails with
  `AccountDidNotDeserialize` (3003) in every instruction: agent calls, every owner instruction, and checkpoint.
- There is no realloc or migration instruction and no close instruction.
- The PDA `[b"guard", user]` stays occupied, so `init_guard` for that Velocity user fails forever with
  "account already in use".

**Proof (LiteSVM, `q4_old_layout_guard_under_head`)**
- A guard created by the 3ca9666 binary is 967 bytes.
- After the program is upgraded to HEAD, all of these fail with 3003: the agent's cancel, the owner's
  `set_agent(default)` revoke, and the owner's checkpoint.
- `init_guard` again fails (system error 0, account in use).
- The owner's only remaining lever is Velocity's own `update_user_delegate`, which works.

**Proof (devnet, simulation only)**
- Devnet runs the HEAD binary. `getProgramAccounts` lists 11 guards: five of 865 bytes, three of 950, two of 967 and one
  of 999.
- A simulated checkpoint fails with 3003 on `HHpGNsHr1jPn8xAdXBF1k57Q2W37Qwbcj1ApV2DhaHoS` (967, the dashboard's
  default guard), on `J5G6Lgg...` (967) and on `4VWusX...` (950).
- On `AqMLdTG...` (999) it gets past deserialization and stops at MissingMarketAccount, as expected with no market
  accounts passed.

**Impact**
- No funds are at risk: the guard fails closed and the owner can remove the delegate on Velocity.
- But every guard made before an upgrade becomes permanently unusable through the guard, including revoking or pausing
  it.
- The public dashboard's default guard on devnet is one of them.
- On mainnet, each append would strand every user.

**Fix**
- Add an owner-only `migrate_guard` that uses Anchor `realloc = 8 + Guard::INIT_SPACE, realloc::payer = owner,
  realloc::zero = true`. It must load the guard through `UncheckedAccount`, or as a separate account type for the old
  size, because deserializing would fail.
- Or reserve padding now, so later fields fit without growing the account.
- Add an owner `close_guard` so the PDA can be recreated.
- Then migrate or recreate the devnet demo guards and repoint the dashboard.

## R3-2 (Low to Medium, CONFIRMED): with no keeper set, the agent can still pull the day's baseline down to a dip just before midnight

**Where**
- `observe_guard`, `lib.rs:579-587`.
- `last_seen_equity` is overwritten on every observed call. A refused cancel is a free, successful observation (it
  must carry the accounts, but it costs only a fee).
- The new day's baseline is `max(equity now, last_seen + flows)` (`:581-583`).

**Probe `n2_residual_dips_around_midnight`.** Setup: long 5 SOL, cap 20.
1. At 23:59 the price is 5% down, and the agent sends a refused cancel. That is observed: `last_seen` = 977.69.
2. At 00:00:30 the price has recovered (midnight equity 1,000.54).
3. At 02:00 it dips 5% again, and the agent's first bid of the day sets the baseline to 977.69. The bid is **accepted**.
4. Twin: the owner's keeper marks at 00:00:30, giving baseline 1,000.54. The same 02:00 bid is refused by G10 (loss
   22.85).

The agent observes at every new low and stays silent on the way up, so `last_seen` tracks the minimum of its chosen
moments. The erased loss is the midnight equity minus `max(last pre-midnight dip, first post-midnight dip)`. It is
bounded by intraday swings, but here it exceeded the whole cap. The anyone or agent checkpoint does the same job as the
refused cancel.

**What is fixed (N2 rerun)**
- The round-2 idle attack is closed: no call at the open, then a first bid after a 5% drop. The baseline stays at the
  last seen 1,000.00, and the bid is refused by G10.
- An untrusted checkpoint in the first hour gets the max rule, not the direct mark (anyone and agent both confirmed).
- Only the keeper's first-hour checkpoint sets the direct mark (confirmed).
- Stale-oracle timing gives no lever. A stale market skips the observation, which leaves `last_seen` unchanged, and the
  max rule never lowers the baseline. A non-exit order errors StaleOracle before G10 anyway.

**Fix (pick one)**
- Make the keeper part of setup (client and README), with a G10 cap refused until a keeper is named.
- Or make the carry robust to timing: keep the highest equity seen in the last hour before midnight (observations in
  that hour may only raise the carry), and use it in the max.

## Q3: can an honest cancel or exit now be blocked?

At 59a98f8 and HEAD, only a missing account fails the observation (`:565`, `:571`). State errors skip it.

| Case | Result | Status |
|---|---|---|
| Zero oracle price | Cancel passes | CONFIRMED |
| Overflow (`MathOverflow`) | Skips the observation | By code |
| Account that does not load | Skips the observation | By code |
| Unsupported oracle source on another market | Skips the observation (`market_price` returns UnsupportedOracle, which is not MissingMarketAccount) | By code |
| Missing perp market account on a cancel | Fails with 6020 | By design: every caller can pass the key, even for a closed oracle, since `find` matches keys only |
| Market removed from the allowlist | Exit refused by G2 (6001) | Unchanged design, documented as a delist note; see round-2 N4(b) |
| Zero or closed spot balance | Collateral reads 0 and the observation proceeds | Only the SpotMarket 0 account is required |

**Unsupported source, probe artifact.** I patched market 0's source byte, so Velocity itself could no longer load its
Lazer oracle (Velocity error 6022). The guard side had already skipped.

**Exit on a market whose own oracle is unsupported.** It still fails with 6021 (`check_order`). This is pre-existing,
and Velocity could not price that market either.

**At 3ca9666.** All of the state-error cases above would have failed every call. 59a98f8 fixed this.

## Q1: round-2 findings rerun

| Finding | What I ran | Result |
|---|---|---|
| N1 | Long 5 SOL, G10 tripped (22.85 vs cap 20), G5 over the cap | Fixed. The first plain SELL 5 passes as a true exit. A second SELL 5 and a single SELL 10 are refused by G10. The waiver is at `:713`. |
| N2 | Idle attack | Fixed. Residual: R3-2. |
| N3 | Exit without `max_ts` under a 60 s cap | Fixed. Refused (6030); it now checks both pre-CPI (`:641`) and in the stored check. |
| N4 | Owner reduce-only take-profit for the full position, paused | Fixed. The agent's exit is accepted as G9; only guard ids count (`:630`). |
| N5 | Second reduce-only SELL beyond the guard's resting exit | Fixed. Refused (6034, `:666`). |

## Q4: other new code

- **Checkpoint.**
  - `has_one = velocity_user` binds the user to the guard. The guard is `Account<Guard>`, so it is program-owned and
    discriminator-checked, and it needs no seeds check.
  - The caller is a `Signer`. `trusted` is owner, or a non-default keeper (`:100`).
  - Spam only rewrites `last_seen`, which is the R3-2 lever.
- **Panics.** None found. Every `try_from` in `observe_guard` now skips, `rem_euclid` cannot panic, and indices are
  bounded.
- **Rent.** New guards pay rent for 999 bytes at `init_guard` (owner pays). The size issue for existing guards is R3-1.
- **No account confusion.**
  - `observe` and `check_order` read the same remaining accounts by key.
  - The G10 path in `check_order` uses the baseline that `observe` stored in the same call (`loss_day == today`).
  - Its fallback branch applies the same max rule.

## Appendix: probe code (r3probe.rs, uses the repo's tests-litesvm harness at HEAD)

```rust
fn goto(env: &mut Env, days_ahead: i64, secs: i64, price: u64) {
    let now = env.now();
    let target = (now.div_euclid(DAY) + days_ahead) * DAY + secs;
    assert!(target > now, "goto must move forward");
    let slots = ((target - now) as u64 * 5).div_ceil(2);
    env.step(slots, price);
}

fn n2_residual_dips_around_midnight() {
    for keeper_marks in [true, false] {
        let (mut env, g) = g10_setup();
        let ok = g.owner.insecure_clone();
        let keeper = solana_keypair::Keypair::new();
        env.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
        assert_ok(&env.set_keeper("owner names keeper", &g, &ok, &keeper.pubkey()));
        goto(&mut env, 1, -60, pct(0.95)); // 23:59 today, a 5% dip
        let r = refused_cancel(&mut env, &g, "agent: refused cancel at the 23:59 dip (observed)");
        env.note(format!("keeper={keeper_marks}: 23:59 observe ok={} last_seen {}", r.is_ok(), env.guard_state(&g).last_seen_equity));
        goto(&mut env, 0, DAY + 30, P0); // 00:00:30 next day, recovered
        if keeper_marks {
            let r = env.checkpoint_as("keeper marks 00:00:30", &g, &keeper);
            env.note(format!("keeper mark ok={} baseline {}", r.is_ok(), env.guard_state(&g).baseline_equity));
        }
        goto(&mut env, 0, 7_200, pct(0.95)); // 02:00, dip again
        let r = env.gplace("agent bid at the 02:00 dip", &g, small_bid(pct(0.95)));
        env.note(format!("keeper={keeper_marks}: bid {} baseline {}", ev(&r), env.guard_state(&g).baseline_equity));
        log(&env, &format!("n2-residual-{keeper_marks}"));
    }
}

fn q4_old_layout_guard_under_head() {
    let mut env = Env::new();
    env.svm.add_program_from_file(GUARD, "guard-3ca9666.so").unwrap();
    env.step(1, P0);
    let g = env.guarded(1_000, tight());
    env.step(2, P0);
    let size_old = env.svm.get_account(&g.guard).unwrap().data.len();
    let r = env.gplace("old binary: agent bid", &g, small_bid(P0));
    env.note(format!("old binary bid {} size {}", ev(&r), size_old));
    env.svm.add_program_from_file(GUARD, "guard-head.so").unwrap();
    env.step(2, P0);
    let ok = g.owner.insecure_clone();
    let r = env.gcancel("HEAD: agent cancel", &g, env.last_guard_order_raw(&g));
    env.note(format!("HEAD cancel {}", ev(&r)));
    let r = env.set_agent("HEAD: owner revokes the agent", &g, &ok, &solana_address::Address::default());
    env.note(format!("HEAD owner revoke {}", ev(&r)));
    let r = env.checkpoint_as("HEAD: owner checkpoint", &g, &ok);
    env.note(format!("HEAD checkpoint {}", ev(&r)));
    let r = env.send("HEAD: owner init_guard again", vec![Env::init_guard_ix(&ok.pubkey(), &g.agent.pubkey(), &tight())], &[&ok]);
    env.note(format!("HEAD re-init {}", ev(&r)));
    let r = env.send("owner removes the delegate on Velocity", vec![Env::delegate_ix(&ok.pubkey(), &solana_address::Address::default())], &[&ok]);
    env.note(format!("Velocity delegate removal ok={}", r.is_ok()));
    log(&env, "q4-layout");
}
```

Devnet check: simulateTransaction of `checkpoint` (accounts: guard owner as signer and fee payer, guard, its velocity_user), sigVerify false, replaceRecentBlockhash true; results 3003 for 967 and 950 byte guards, 6020 for the 999 byte guard.
