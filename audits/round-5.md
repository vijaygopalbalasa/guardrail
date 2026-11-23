# Guardrail security review, round 5 (final program review, Nov 22 2026)

## Scope and method

**What I reviewed.** The diff 089fb1c..HEAD 85d80ac (commits a2796fe, 5a3c00e and 85d80ac), in `programs/guard/src/lib.rs`
and `scripts/keeper.mjs`.

**Where I worked.** A fresh `git clone` at a temporary directory, with build caches cloned copy-on-write.
The original was never written to, and the clone is deleted.

**Binaries.**
- HEAD's `guard.so` (sha256 9da5be27...6e7a).
- Three real older binaries:
  - e205a31: 1135 bytes, no day high. Its hash 1ad503ee equals the current devnet hash in `notes/devnet-guard-so.sha256`,
    so devnet does not run HEAD yet.
  - 3ca9666: 967 bytes.
  - daed8a1: 352 bytes.

**Tests.** All repo suites pass in the clone. I ran 4 REPLAY probe tests (`r5probe.rs`) on Velocity's real devnet
binary.

Line references are to HEAD `programs/guard/src/lib.rs`.

## Q1. Earlier findings rerun: all fixed

In every row, a keeper is named but does not mark the day, which is the case these rules exist for.

| Item | What I ran | Result |
|---|---|---|
| R3-2 | 23:59 dip on a day with earlier calls | 02:00 dip bid refused G10, baseline 999.99. Fixed. |
| R4-2 | 22:59 dip | Refused, baseline 999.99. Fixed. |
| R4-2 | 23:59 dip as the first call of that day | Refused, baseline 999.99. Fixed. |
| R4-1 | Real 352-byte guard (round-1 binary) | Migrate refused (6036). `close_guard` and `init_guard` recover it. Fixed. |
| R4-1 | Real 967-byte guard | Migrates to 1135 bytes, the agent trades, and the day high is seeded. |
| R4-4 | `set_keeper(default)` while capped | Refused (6035). Allowed once the cap is 0. Fixed. |
| R4-3 | keeper.mjs | Now schedules by chain time and retries until `loss_day` equals the chain day. See finding 3 for two edges. |

## Q2. Can the agent still lower the baseline or day high?

No agent lever found at HEAD. Details:

**Account choices.** Nothing changed here. Only a missing account fails the call, and every account is found by key.

**Timing.** The day high only rises within a day. A new day's baseline without a mark is
`max(eq, last_seen, day_high)` (`new_day_baseline`, `lib.rs:670`). The day high is reseeded from that baseline
(`:646`), so the carry persists from day to day until a mark.

**Gaps of two or more days.** After 3 silent days, the first bid at a 5% dip is refused with baseline 999.99. The next
midnight mark by the owner-keeper resets the baseline to 977.69, and the bid passes.

**Pre-empting the keeper.** An agent call at 00:00:01 sets the baseline by the max rule, which is at least the keeper's
mark. That only hurts the agent.

**Migrate mid-day.** Migrated guards start with `day_high_day = 0`, and the seeding uses that day's baseline and last
equity seen. A 967-byte guard migrated mid-day seeds the day high at 999.99 on its first observation.

### Finding 1 (Low, CONFIRMED, one time): the day the program is upgraded from e205a31, a pre-midnight dip seen by the old binary becomes the next day's baseline

**Why it happens.** Guards made by e205a31 are already 1135 bytes, so they get no migrate. Their day high bytes come from
the zero reserved area, so `day_high_of` returns None.

**Probe `q2_upgrade_mid_day_from_e205a31`.**
1. Under the old binary: a morning baseline of 1,000.54, then a refused cancel at a 22:59 dip, so `last_seen` = 977.69.
2. The program is upgraded at 23:30. No HEAD call happens before midnight, and there is no mark.
3. The 02:00 dip bid is **accepted**, with baseline 977.69.
4. Twin: one HEAD call at 23:30 seeds the day high from that day's baseline (1,000.54), and the same bid is refused.

**Bound.** This is round-4 item 2 surviving for the single night of the upgrade, and only when the keeper misses that
night's mark. Devnet guards will cross this window when devnet moves from e205a31 to HEAD.

**Fix (optional).** When `day_high_of` is None, include the stored day's baseline (`adj(baseline_equity, baseline_flows)`)
in `new_day_baseline`. Or simply run the keeper on the night of the upgrade, which is already required.

## Q3. Is any honest cancel or exit blocked?

No. The diff does not touch how observations fail.

**Probe `q3_carry_without_mark_blocks_new_risk_not_exits`.** Over three days with the carried high binding:
- reduce-only exits are accepted (rule 9)
- cancels pass
- only new risk is refused (G10)

### Finding 2 (Info, design, CONFIRMED): with no keeper marks, G10 becomes a high-water drawdown cap that never resets, so an honest agent can be shut out of new risk for days

**Probe `q3_carry_without_mark_blocks_new_risk_not_exits`.**
1. An unrealized gain is seen at the high (day high 1,027.96).
2. The price returns to its starting level.
3. On each of the next three days, an honest bid at the start price is refused with G10. The baseline stays 1,027.96,
   so the 27.96 gain that was given back counts as a loss against the 20 cap.

**When it bites.** The quickstart names the owner's own key as keeper. If the owner never runs `keeper.mjs`, this is the
permanent behaviour. The owner cannot reset the baseline mid-day; the only escapes are a first-hour mark or cap 0.

**What to do.** Fail-safe for the owner, so it belongs in "Not claimed" or a README line: "without a keeper mark, a given-back
gain counts as loss until the next mark".

## Q4. Anything else new

### Finding 3 (Low, client): `keeper.mjs` edge cases

**Null block time** (`keeper.mjs:26`, `:58-59`). `getBlockTime` can return null. `null % 86_400` is 0 in JS, so the
scheduler sleeps about 24 h and then fires at an arbitrary time of day. That day's direct mark is lost, which falls
back to the conservative carry. Fix: retry `chainTime` until it is non-null, or read the Clock sysvar.

**Owners are marked in series** (`:52`). With 60 tries x 30 s each, one failing owner delays the next by up to
30 minutes. A third owner can end up past the first hour, and then gets the max rule instead of the mark. Fix:
`Promise.all` over owners.

**"(day marked)" is printed whenever `loss_day` equals today.** That includes a day an agent call pre-empted with the
max rule. It is harmless, but the log then claims a midnight mark that did not happen.

### Finding 4 (Info): nothing stops the owner naming the agent's own key as the keeper

`set_keeper` (`:109`) and `set_agent` (`:76`) do not stop `keeper == agent`. If that happens, the agent can set the
direct mark at the lowest point of the first hour. It is an owner misconfiguration, and a cheap check closes it:
refuse `keeper == agent` in both setters.

## Verified sound in the diff

- `MIGRATABLE_LENGTHS` = [865, 950, 967, 999] (`:125`). These are exactly the layouts I showed in round 4 to be prefixes
  of HEAD.
- The reserved area went from 128 to 104 bytes, which pays for the 24 bytes of day-high fields. `INIT_SPACE` is
  unchanged at 1135, and existing 1135-byte guards read zeros there.
- `new_day_baseline` is shared by `observe` and the `check_order` fallback. The deposit adjustment uses saturating
  arithmetic.
- `set_keeper` refuses default while capped.
- A stale or skipped observation never updates the day high, so skipping cannot lower it.
- No new panics.

## Appendix: probe code (r5probe.rs, uses the repo's tests-litesvm harness at HEAD)

```rust
fn q2_upgrade_mid_day_from_e205a31() {
    for upgrade_then_call in [false, true] {
        let (mut env, g) = g10_with(Some("e205a31"));
        goto(&mut env, 1, 3_000, P0); // next day 00:50: first call takes that day's baseline (max rule)
        let r = env.gplace("old binary: morning bid (baseline)", &g, bid(P0));
        env.note(format!("[upgrade, call after={upgrade_then_call}] morning {} baseline {}", ev(&r), env.guard_state(&g).baseline_equity));
        let _ = env.gcancel_raw(&g.owner.insecure_clone());
        goto(&mut env, 0, DAY - 3_660, pct(0.95));
        let r = env.gcancel("old binary: refused cancel at the 22:59 dip", &g, None);
        env.note(format!("old 22:59 observe ok={} last_seen {}", r.is_ok(), env.guard_state(&g).last_seen_equity));
        env.svm.add_program_from_file(GUARD, format!("{D}/guard-head.so")).unwrap();
        goto(&mut env, 0, DAY - 1_800, pct(0.95));
        if upgrade_then_call {
            let r = env.gcancel("HEAD: refused cancel at 23:30 (dip)", &g, None);
            env.note(format!("HEAD 23:30 observe ok={} day_high {:?}", r.is_ok(), hi(&env, &g)));
        }
        goto(&mut env, 0, DAY + 30, P0);
        goto(&mut env, 0, 7_200, pct(0.95));
        let r = env.gplace("HEAD: bid at the 02:00 dip", &g, bid(pct(0.95)));
        env.note(format!("[upgrade, call after={upgrade_then_call}] 02:00 bid {} baseline {}", ev(&r), env.guard_state(&g).baseline_equity));
        log(&env, &format!("upgrade-{upgrade_then_call}"));
    }
}

fn q3_carry_without_mark_blocks_new_risk_not_exits() {
    let (mut env, g) = g10_with(None);
    env.step(5, pct(1.06)); // equity rises (unrealized gain ~27)
    let r = env.gcancel("agent observes at the high", &g, None);
    env.note(format!("observe at high ok={} day_high {:?}", r.is_ok(), hi(&env, &g)));
    env.step(5, P0); // back to P0: a ~27 drop from the high
    for d in 1..=3 {
        goto(&mut env, 1, 7_200, P0);
        let r = env.gplace(&format!("day +{d}: honest bid at P0"), &g, bid(P0));
        let mut ex = Order::resting(1, BASE, P0 + 50_000);
        ex.reduce_only = true;
        let r2 = env.gplace(&format!("day +{d}: exit"), &g, ex);
        let id = env.last_guard_order(&g);
        let r3 = env.gcancel(&format!("day +{d}: cancel the exit"), &g, id);
        env.note(format!("day +{d}: bid {} baseline {} | exit {} | cancel ok={}", ev(&r), env.guard_state(&g).baseline_equity, ev(&r2), r3.is_ok()));
    }
    log(&env, "carry");
}
```
