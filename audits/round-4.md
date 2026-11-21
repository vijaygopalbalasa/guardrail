# Guardrail security review, round 4 (Nov 21 2026)

## Scope and method

**What I reviewed.** The program delta a013bd2..HEAD 3eb0e52 (program commit 58d9b40), plus `scripts/keeper.mjs` and the
client's `migrateGuard`, `closeGuard` and `checkpoint`. The delta covers:
- `migrate_guard` and `close_guard`
- the 128 reserved bytes
- KeeperRequired (6035)
- `last_seen_day` with the last-hour raise-only rule

**How I tested.**
- I exported HEAD into a temporary directory with copy-on-write build caches.
- I built HEAD's `guard.so`. It is byte-identical to the repo's and to `notes/devnet-guard-so.sha256` (1ad503ee...3f4b).
- I also built three REAL older binaries:
  - 31afb12: 967-byte guard
  - 75ece0f: 865-byte guard, the last layout before G10
  - dfa815f: 352-byte guard; this is the round-1 binary, sha256 1d8b3d2c..., the one I audited in round 1
- In each probe, the old binary creates the guard and uses it (an accepted order, a G1 refusal, a pause). Then the program
  account is replaced by HEAD and the guard is migrated.
- All repo suites pass. 6 REPLAY probes (`r4probe.rs`) ran on Velocity's real devnet binary.
- Devnet was only read: `getProgramAccounts` and `getAccountInfo`.
- The repo was never written to, and the temporary copy is deleted.

Line references are to HEAD `programs/guard/src/lib.rs`.

## Results, ranked

### 1. Low: `migrate_guard` accepts pre-865 layouts that are not prefixes of HEAD, and produces a misaligned guard (CONFIRMED with the real round-1 binary)

**Where.**
- `check_guard_account` accepts any length of at least 72 bytes.
- `migrate_guard` only requires `len < 8 + INIT_SPACE`.

**What I found.**
- I flattened every historical Guard layout field by field. Every layout from 865 bytes up (865, 950, 967, 999) is an
  exact prefix of HEAD.
- The earlier layouts (235, 344, 352 bytes) are not prefixes: `Limits` grew from 121 to 129 bytes when
  `max_order_lifetime_secs` was added inside `Limits`, so everything after it shifts by 8.

**What the probe showed.**
- The real dfa815f guard (352 bytes) "migrates" with OK.
- The agent then fails every call with ConstraintSeeds 2006, because `bump` is read from a shifted byte.
- The owner's `set_paused` succeeds and writes into misaligned fields.
- `limits.max_order_lifetime_secs` now holds the old `day` number.
- It fails closed, and `close_guard` plus `init_guard` recovers it.
- No 352-byte guard exists on devnet today (devnet sizes: 865 x5, 950 x2, 967 x2, 999 x2, 1135 x3).

**Fix.** Allow migration only from known append-only lengths (865, 950, 967, 999). Point older guards to
`close_guard`, and change the "any layout" comment.

### 2. Low (residual R3-2): the last-hour raise-only rule has two easy ways around it (CONFIRMED)

**Where.** `observe_guard`, `lib.rs:636-643`.

**What I found.** The rule applies only to readings in 23:00-24:00 UTC, and only when `last_seen_day == today`. It
matters only when the keeper's first-hour mark does not happen. The owner set a keeper but it did not run in the
probes (`r3_2_rerun_and_variants`):

| Agent observes at a 5% dip | `last_seen` | Midnight | 02:00 dip bid | Result |
|---|---|---|---|---|
| 23:59, same day as earlier calls (R3-2 as reported) | stays 999.99 | recovered | refused G10 | **Fixed** |
| 22:59, before the last hour | 977.69 | recovered | accepted, baseline 977.69 | Bypass |
| 23:59, as the first call of that day (`last_seen_day` was yesterday) | 977.69 | recovered | accepted, baseline 977.69 | Bypass |

**Why it is only Low.** KeeperRequired makes the keeper the real defence. The table matters only when the keeper misses
its mark (see 3).

**Fix (either).**
- Track the highest equity seen over the whole previous day, not only the last hour.
- Or, simpler: when the day rolls without a keeper mark, take the baseline as `max(eq, last_seen, prev_day_high)`.

### 3. Low: `scripts/keeper.mjs` makes one attempt per day, timed by the local clock, with no retry and no check that the mark landed

**Where.** `scripts/keeper.mjs:24-44`.

**What I found.**
- It fires once, 5 s after the local 00:00 UTC.
- An error is logged and the script sleeps another 24 h.
- It never checks that the guard's `loss_day` moved to the chain's new day.

**When the mark is lost.**
- One transient RPC error loses that day's mark, which reopens finding 2.
- If the chain's `unix_timestamp` lags the machine clock by more than 5 s, the checkpoint lands as a 23:59:5x reading of
  the old day. That makes it a raise-only observation, not a mark, and the script still sleeps 24 h.
- A compromised keeper key can mark at the lowest point in the first hour. That is inherent to trusting a keeper.

**Fix.**
- Read the chain time (Clock sysvar or `getBlockTime`) to schedule.
- After sending, read the guard and retry until `loss_day` equals the chain day, for up to the first hour.
- Alert if the hour ends without a mark.

### 4. Info: KeeperRequired is enforced only inside `set_daily_loss`

**Confirmed.**
- `set_daily_loss` without a keeper fails with 6035.
- `set_keeper(default)` after a cap is set succeeds and leaves cap 20 with no keeper.

**By code.** A migrated 950/967 guard that already had a cap keeps it with keeper = default.

**Fix.** Either refuse `set_keeper(default)` while `max_daily_loss > 0`, or treat "cap without keeper" as cap off. Ask
the owners of migrated capped guards to name a keeper.

### 5. Info: devnet still holds 11 guards at old layouts, and the README and receipts link 10 of them

- The receipts' transactions remain valid history. But those guards fail with 3003 until their owners migrate.
- Among them are `HHpGN...` (967) and `AqML...` (999).
- The dashboard default is now `9NJpR...`, which is 1135 bytes and fine.
- Fix: migrate them, or label them as historical.

## Verified sound

**`migrate_guard` on real old guards (31afb12, 967 bytes; 75ece0f, 865 bytes).**
- Before migration, agent calls fail with 3003.
- The agent or a stranger calling migrate or close is refused with NotOwner (6010).
- The owner's migrate succeeds:
  - It grows the account to 1135 bytes and tops lamports up to exactly the rent-exempt minimum (6,416,040).
  - The old bytes are byte-for-byte intact.
  - owner, Velocity user, agent, `paused`, the counters (accepted 1, G1 refused 1) and `placed_order_ids` [1] all read
    correctly. The cap is 0, the keeper is default and `last_seen_day` is 0.
- A second migrate is refused (6036).
- After migration:
  - the owner can unpause
  - the agent trades
  - G1 still refuses an 8 SOL order
  - the order the old binary placed is still cancellable through the guard

**`close_guard`.**
- The owner gets 6,416,040 lamports back and the account is gone.
- The agent then fails with AccountNotInitialized (3012). So the Velocity delegate, which still points at the PDA, is
  inert: only the guard program can sign as the PDA, and it needs a live Guard.
- `init_guard` recreates the PDA at 1135 bytes, and the agent trades again without re-delegating.
- A third party pre-funding the PDA address does not block re-init.
- Re-init is still bound to the Velocity authority (G0).
- Orders the guard had resting stay on Velocity until the owner cancels them directly (document this).

**Reserved bytes.** The 128 zero bytes are serialized back on every write. A future field carved from them must treat
zero as its default.

**Realloc.** The largest growth (352 to 1135 bytes) is far under the 10 KiB per-instruction limit.

**Client.** `migrateGuard` and `closeGuard` pass `[owner (signer, writable), guard PDA (writable), system program]`,
which matches `GuardByOwner`. `checkpoint` builds the remaining accounts from the user's active markets, which matches
the program's rule.

## Appendix: probe code (r4probe.rs, uses the repo's tests-litesvm harness at HEAD; old binaries built from git)

```rust
fn old_guard_migrates(commit: &str, make_orders: bool) {
    let mut env = Env::new();
    env.svm.add_program_from_file(GUARD, format!("{D}/guard-{commit}.so")).unwrap();
    env.step(1, P0);
    let g = env.guarded(10_000, tight());
    env.step(2, P0);
    let ok = g.owner.insecure_clone();
    if make_orders {
        let r = env.gplace("old binary: agent bid", &g, Order::resting(0, BASE, 91_000_000));
        env.note(format!("[{commit}] old bid {}", ev(&r)));
        let r = env.gplace("old binary: refused bid (G1)", &g, Order::resting(0, 8 * BASE, 91_000_000));
        env.note(format!("[{commit}] old refused bid {}", ev(&r)));
        let _ = env.set_paused("old binary: pause", &g, &ok, true);
    }
    let len_old = env.svm.get_account(&g.guard).unwrap().data.len();
    let lam_old = env.svm.get_account(&g.guard).unwrap().lamports;
    let raw_old = env.svm.get_account(&g.guard).unwrap().data;
    env.svm.add_program_from_file(GUARD, format!("{D}/guard-head.so")).unwrap();
    env.step(2, P0);
    let r = env.gcancel("HEAD before migrate: agent cancel", &g, Some(1));
    env.note(format!("[{commit}] size {len_old}: cancel before migrate {}", ev(&r)));
    // griefing attempts
    let agent = g.agent.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let r = env.migrate_guard("agent migrates", &g, &agent);
    env.note(format!("[{commit}] agent migrate {}", ev(&r)));
    let r = env.close_guard("stranger closes", &g, &stranger);
    env.note(format!("[{commit}] stranger close {}", ev(&r)));
    let r = env.migrate_guard("owner migrates", &g, &ok);
    let acc = env.svm.get_account(&g.guard).unwrap();
    let rent = env.svm.minimum_balance_for_rent_exemption(acc.data.len());
    env.note(format!("[{commit}] migrate {} size {} -> {}, lamports {} -> {} (rent-exempt min {}), old prefix intact {}",
        ev(&r), len_old, acc.data.len(), lam_old, acc.lamports, rent, acc.data[..len_old] == raw_old[..]));
    let s = env.guard_state(&g);
    env.note(format!("[{commit}] after migrate: {}", summary(&env, &g)));
    let _ = s;
    let r = env.migrate_guard("owner migrates twice", &g, &ok);
    env.note(format!("[{commit}] second migrate {}", ev(&r)));
    // the migrated guard works for owner and agent
    let r = env.set_paused("owner unpauses", &g, &ok, false);
    env.note(format!("[{commit}] owner set_paused {}", ev(&r)));
    let r = env.gplace("agent bid after migrate", &g, Order::resting(0, BASE, 91_050_000));
    env.note(format!("[{commit}] agent bid {}", ev(&r)));
    let r = env.gplace("agent bid over G1 after migrate", &g, Order::resting(0, 8 * BASE, 91_050_000));
    env.note(format!("[{commit}] agent G1 bid {}", ev(&r)));
    if make_orders {
        let r = env.gcancel("agent cancels the order placed by the old binary", &g, Some(1));
        env.note(format!("[{commit}] cancel old-binary order {} open now {:?}", ev(&r), raw_orders(&env, &g.owner.pubkey()).iter().map(|o| o.order_id).collect::<Vec<_>>()));
    }
    // close: delegate still points at the PDA; the agent cannot trade; re-init brings it back without re-delegating
    let lam_owner = env.svm.get_account(&ok.pubkey()).unwrap().lamports;
    let r = env.close_guard("owner closes", &g, &ok);
    env.note(format!("[{commit}] close {} owner +{} lamports, guard exists {}", ev(&r), env.svm.get_account(&ok.pubkey()).unwrap().lamports as i128 - lam_owner as i128,
        env.svm.get_account(&g.guard).map(|a| a.lamports > 0).unwrap_or(false)));
    let r = env.gplace("agent bid after close", &g, Order::resting(0, BASE, 91_050_000));
    env.note(format!("[{commit}] agent after close {}", ev(&r)));
    let r = env.init_guard_again("owner init again", &g, &tight());
    env.note(format!("[{commit}] re-init {} size {}", ev(&r), env.svm.get_account(&g.guard).map(|a| a.data.len()).unwrap_or(0)));
    let r = env.gplace("agent bid after re-init (no re-delegation)", &g, Order::resting(0, BASE, 91_060_000));
    env.note(format!("[{commit}] agent after re-init {}", ev(&r)));
    log(&env, &format!("migrate-{commit}"));
}

fn r3_2_rerun_and_variants() {
    // variant: (label, days to the observation day, seconds into that day for the dip observation)
    for (label, obs_day, obs_secs) in [("23:59 dip, same day as earlier calls", 0i64, DAY - 60), ("22:59 dip (before the last hour)", 0, DAY - 3_660), ("23:59 dip, first call of that day", 1, DAY - 60)] {
        let (mut env, g) = g10();
        goto(&mut env, obs_day, obs_secs, pct(0.95));
        let r = env.gcancel("agent: refused cancel at the dip", &g, None);
        let s = env.guard_state(&g);
        env.note(format!("[{label}] observe ok={} last_seen {} day {}", r.is_ok(), s.last_seen_equity, lsd(&env, &g)));
        goto(&mut env, 0, DAY + 30, P0); // midnight, recovered; the keeper does not run
        goto(&mut env, 0, 7_200, pct(0.95)); // 02:00 dip
        let r = env.gplace("agent bid at the 02:00 dip", &g, bid(pct(0.95)));
        env.note(format!("[{label}] 02:00 bid {} baseline {}", ev(&r), env.guard_state(&g).baseline_equity));
        log(&env, &format!("r32-{}", obs_secs));
    }
}
```
