# Guardrail phase A: red, green and planted bugs (2026-11-21)

All runs are REPLAYS: Velocity's real devnet binary (sha256 in fixtures/velocity-devnet.so.sha256) in LiteSVM 0.18.2,
devnet state cloned Nov 21 2026, oracle prices written by the tests, real fills from a flow account.

## Red
- Limit tests (tests-litesvm/tests/limits.rs) against the stub (every handler empty): 29 of 30 failed. The pass was the
  direct-bypass test, which exercises Velocity's own constraint. Honest caveat: 12 of the 29 failed on the stub's unset
  bump (Anchor error 2006) rather than on their own assertions. Output: notes/red-run.txt.
- Round 2 (review round): new tests for G6 on every price field, the exit price band and other-spot borrows failed
  on the first implementation (4 of 38: two let through by the guard and refused only by Velocity, one exit at 12.5%
  under the oracle accepted, one borrow ignored). Output: notes/red2-run.txt.
- Math property tests against the stub math: 9 of 11 failed (the two passes are soundness properties that hold
  vacuously; each is paired with a completeness property that failed). Output: notes/red-math-run.txt.

## Green
- 38 limit tests pass (notes/green-run.txt); 11 math tests pass, 20,000 cases per property.
- Probe of an exit far under the oracle (tests/probe.rs, notes/probe-exit-price.txt): Velocity accepts a reduce-only
  sell at $80 with the oracle at $91.39 and gives it a 180-slot auction ending at $80; its own fill band is about 20%
  (margin_ratio_initial). So exits now must stay inside the owner's G6 band too.
- Probe of Velocity itself (tests/probe.rs, notes/probe-velocity.txt): reduce-only orders are accepted at placement in
  any direction and counted in open_bids/open_asks; at fill time Velocity clamps them so a position never flips.

## Planted bugs (scripts/planted-bug.sh, notes/planted-bug-run.txt)
27 plants. Each breaks one limit; every plant is caught. A plant fails between 1 and 6 tests, all of which depend on
that limit (the G9 tests use the limit under test to show a new order being refused):
G1 off by one; G2 market index ignored, order-type check removed, builder check removed; G3 running total forgotten,
never resets on a new day; G4 ignores this order, first-match slot lookup; G5 ignores unrealized PnL, check removed;
G6 limit band skipped, auction band skipped, oracle offset skipped, staleness off by one; G7 pause ignored, owner check
removed, revoked agent still trades; G9 exit need not oppose the position, exits blocked by limits; G8 a third Velocity
discriminator appears; post-trade check off by one; G6 price field, oracle offset, auction prices and a Market order
without a worst price; G9 exit skips the band; G5 borrow in another spot market ignored. Sources are restored from a copy and compared byte for byte.

## Runaway replay (tests/runaway.rs, notes/runaway-replay.txt)
Same agent loop and price path, unguarded vs guarded; headline lines at the end of the report.

## Round 3 (2026-11-21): refusals as recorded successes, stale exits
- Refusals return Ok, do not call Velocity, leave the Velocity User byte-identical, bump exactly one per-rule
  counter and store last_refusal (tests: every_refusal_leaves_velocity_untouched_and_bumps_exactly_one_counter and
  others). Red before the change: notes/red3-run.txt (33 failed).
- Stale exits: past exit_max_staleness_slots, an exit may only be priced on the owner-favourable side of the last
  oracle price (sell at or above, buy at or below; no market order without a price; offsets and auction prices
  checked the same way). Red: notes/red4-run.txt. Green: 46 replay tests (notes/green-run.txt).
- Planted bugs: 29 plants, all caught (notes/planted-bug-run.txt). The script now aborts if a plant site is not
  unique; an earlier run had two plants silently not applied because a refactor duplicated their text.
- Full suite including client, MCP and dashboard on a local validator: notes/test-all-run.txt.

## Round 4 (2026-11-21): security audit fixes (guardrail-audit-nov21.md)
- Red: the reviewer's probes ported as `tests-litesvm/tests/audit.rs` (9 tests) plus two updated limit tests; all
  failed before the fix (notes/red5-run.txt).
- F1 (High): Oracle orders without an offset are refused (no worst price); the stale-exit rule no longer exempts
  Oracle orders; after the CPI the guard re-reads the order Velocity stored (price, offset, auction prices, including
  auction prices Velocity generates) and fails the transaction if any can execute outside the band on the owner's
  unfavourable side. The reviewer's +7% fill is now impossible (`f1_oracle_order_without_offset_cannot_fill_far_from_the_oracle`).
- F2 (Medium): exits keep G2 (allowed markets and order types); they skip only the pause and G1/G3/G4/G5.
- F3 (Medium): the agent can cancel only orders the guard placed, by id (the guard records placed order ids);
  cancel-all and cancels of the owner's orders are recorded refusals; every cancel emits CancelChecked and is counted.
- F4 (Low): an exit counts the reduce-only orders already resting on its side.
- INFO: owner-set order lifetime (max_ts bound) and a last refusal kept per rule.
- Green: audit 9, limits 47, probes 2, replays 2, math and unit tests 12, client, MCP, demo and dashboard tests.
- Plants: 39 of 40 caught. The one not caught by the replay tests is the post-CPI stored-order check itself: every
  order that would reach it is already refused by the pre-check, so it is defense in depth; the stored-order rule is
  covered by unit tests on the audit's real stored orders, and its plant is caught there.

## Round 5 (Nov 21): review of e328f57, order lifetime and placed order ids

- Probe first (`r5_velocity_stores_max_ts_zero_as_no_expiry_and_skips_a_past_one`): Velocity stores max_ts 0 as
  "never expires" and skips an order whose max_ts is in the past or negative ("max_ts < now, skipping order").
  So the old bound on max_ts - now let max_ts 0 through with no lifetime at all.
- Fix 1: with a lifetime cap set, max_ts must satisfy now < max_ts <= now + cap, or the order is a recorded refusal
  (OrderLifetimeTooLong). After the CPI the guard also checks the stored Order.max_ts the same way.
- Fix 2: the guard no longer uses a ring. Before each order it forgets ids that are no longer open on the Velocity
  User (filled, cancelled by anyone, expired), and writes the new id into a free slot. With 32 guard orders open the
  next order is a recorded refusal (TooManyOpenOrders, 6031); a live id is never evicted, so the agent can always
  cancel its own open orders.
- Red: 4 tests failed on the old program (lifetime: max_ts 0 accepted, past max_ts reached Velocity; the oldest open
  order could not be cancelled after 32 more placements; the 33rd order reached Velocity and failed there).
  A fifth test (ids the owner cancelled directly are pruned) guards the prune itself.
- Plants: 5 of 5 caught (notes/planted-bug-r5.txt); the stored max_ts plant is caught by the program unit test.
- Devnet: upgraded in place (same id), deployed bytes match the build (sha256 in notes/devnet-guard-so.sha256);
  receipts rerun with a fresh runaway guard (notes/devnet-receipts.md).

## Round 6 (Nov 21): G10 daily-loss brake, and orders Velocity does not store

- Probe first (`probe_deposit_and_withdraw_totals`): Velocity's User keeps total_deposits at 4392 and total_withdraws
  at 4400 in quote units (1e6 = 1 dUSDT); a 250 deposit and a 100 withdrawal moved them by exactly 250 and 100.
- G10: the owner sets max_daily_loss (`set_daily_loss`, 0 = off). The day's first risk-increasing order that reaches
  the check stores the baseline (equity = collateral + uPnL, and net deposits then), refused or not, so it never moves
  within a day. Loss = baseline + (net deposits now - then) - equity. Over the cap, risk-increasing orders are
  recorded refusals under rule 10 (own counter and last refusal); exits and cancels never reach the check.
  Choice stated plainly: if the day's first calls are exits, the baseline is taken at the first risk-increasing order,
  so a loss before that moment is not counted for that day.
- The new fields are appended to the Guard account, so earlier offsets do not move; guards created before G10 still
  decode in the dashboard (without G10) but cannot trade on the upgraded program.
- Also: an order Velocity skips (a past max_ts with no lifetime cap) now fails the transaction instead of being counted
  as accepted and charged to G3.
- Red: 10 tests in tests-litesvm/tests/daily_loss.rs failed before the program change (notes/red-g10.txt).
- Plants: 6 of 6 new ones caught (notes/planted-bug-r6.txt). Full run (notes/planted-bug-run.txt): 50 plants, 49
  caught; the one not caught is still the post-CPI stored-order removal (unreachable behind the pre-check). The round 4
  note said 40 plants; the script then held 39.
- Replay: the headline guarded run now carries G10 at 50 dUSDT: refusals 55 G1, 30 G4, 20 G10; worst loss unchanged at
  9.4% (the position was already capped at 10 SOL). With only G10 tight (20 dUSDT): 98 G10 refusals, 14.0% vs 41.2%.
  The brake stops new risk; it does not close a held position.

## Round 7 (Nov 21): G10 baseline at the guard's first call of the day

- Red: `g10_an_exit_first_day_starts_the_count_at_that_exit` and `g10_a_cancel_first_day_starts_the_count_at_that_cancel`
  failed (notes/red-g10-first-call.txt): with an exit or a cancel first, the baseline was only taken later, after the
  price had fallen, so the loss before it was not counted.
- Fix: place_perp_order and cancel_order both take the day's baseline first, when every price they need is present and
  fresh; it never fails the call (with a stale or missing price the next call tries again). Plant caught
  (notes/planted-bug-r7.txt). Devnet upgraded in place, bytes verified (notes/devnet-guard-so.sha256).

## Round 8 (Nov 21): a plain risk-reducing sell is never trapped

- Red (notes/red-r8.txt): with leverage over the cap (the owner tightened G5 after a 10 SOL long), a plain sell of 5 SOL
  that is not flagged reduce-only was refused by G5.
- Fix (first version, tightened below): G4, G5 and G10 refused only orders that raise the market's worst-case exposure
  (position plus resting orders on the worse side plus this order). An order that leaves it no higher passes them and still meets the shape rules,
  G1, G2, G3 and the G6 band. After the CPI, such an order must not have raised worst-case exposure (else the
  transaction fails). Twins in the same test: a 1 SOL buy and a sell that flips past flat are still refused by G5.
- Client and MCP: when reduce_only is left unset, an order that opposes the position and fits inside it (with the
  reduce-only orders already resting) goes in as reduce-only.
- Plants: two (notes/planted-bug-r8.txt).
- Review of the R8 change: "worst-case exposure does not rise" was too loose. A plain sell of twice a long keeps the
  worst case equal (long 5 or short 5) but flips the position, so it could flip back and forth at full exposure while
  over the daily-loss cap. Red: `r8_a_flip_that_keeps_exposure_equal_is_still_checked_by_g5` and
  `g10_a_flip_over_the_cap_is_refused_but_a_true_exit_passes` (notes/red-r8-flip.txt). Fix: G4, G5 and G10 are waived
  only for a true exit (opposes the position; size plus every order resting on that side is at most the position),
  the is_exit test without the reduce-only flag. Plants updated: the review case is one of them.

## Round 9 (Nov 21): audit round 2 (guardrail-audit-r2.md), probes ported to tests-litesvm/tests/audit_r2.rs

- N1 (High): already closed by the true-exit rule (round 8 review); the reviewer's exact probe now passes: two plain
  SELL 5 against a long 5 with G10 tripped, the first (a true exit) accepted, the second refused by G10, the position
  ends flat, never short. It would fail on 34c3902.
- N2 (Medium): the guard records the equity it sees on every call (last_seen_equity and the net deposits then). A new
  day's baseline is the higher of equity now and that last equity adjusted for flows since, so waiting for the low does
  not lower it. A permissionless `checkpoint` instruction (has_one = velocity_user) takes the day's baseline with
  fresh prices. "Baseline set" is now loss_day == today, not baseline_equity != 0.
- N3 (Medium): exits obey max_order_lifetime_secs, before the CPI and in the stored-order check.
- N4 (Medium): G9 counts only the guard's own resting reduce-only orders. The delist case is documented in Not claimed.
- N5 (Low): a reduce-only order that is not an exit is refused (ReduceOnlyBeyondPosition, 6034).
- INFO: README notes the depeg caveat (flows at the quote oracle, collateral 1:1).
- Red: notes/red-audit-r2.txt (5 of 7 failed before the program change; N1 and the no-drop twin passed).
- Plants: 5, all caught (notes/planted-bug-r9.txt).
- Review of the N2 change: observe_guard returned silently when accounts were missing, so the agent could leave them
  out at high equity and include them at the low. Now every guard call (place, exit, cancel, checkpoint) must bring the
  accounts that price every active market (perp market, its oracle, spot market 0), checked by owner and key; a
  missing or wrong one fails the call. Only a stale oracle skips the observation. A checkpoint in the first hour of the
  UTC day sets that day's first baseline to the equity then (a midnight mark); anyone can call it, so an owner's
  keeper at 00:00 UTC keeps it there, and a caller later in that hour can hide at most that hour's move.
  Red on the previous program: notes/red-n2b.txt (3 tests). Plants: 2 more (notes/planted-bug-r10.txt).
- Review of the strict observation: (1) the first-hour midnight mark was permissionless, so the agent could checkpoint
  at 00:59 after a drop and set the day's baseline at the low. Now only the owner or the keeper the owner names
  (`set_keeper`, default none) gets the midnight mark; anyone else gets max(equity now, last seen + flows). (2) observe
  failed calls on state errors (unsupported oracle, overflow, an account that does not load), which could block cancels
  and exits. Now only a missing account (MissingMarketAccount; every account is found by key, so leaving one out is the
  caller's only choice) fails the call; state errors skip the observation. Red: notes/red-n2cd.txt. Plants: 2 more,
  and the R10 plant site updated (notes/planted-bug-r11.txt).

## Round 12 (Nov 21): audit round 3 (guardrail-audit-r3.md), tests in tests-litesvm/tests/audit_r3.rs

- R3-1 (Medium): appending fields bricked older guards (10 of 11 devnet guards fail with 3003). New owner-only
  `migrate_guard` grows a guard of any older layout to the current size (checked by program owner, discriminator,
  owner field and PDA; new bytes zero; the owner pays the rent) and `close_guard` returns the rent so `init_guard` can
  run again. 128 reserved bytes now, so later fields need no migration. Tests simulate older guards by cutting a current
  one to the devnet sizes (865, 950, 967, 999 bytes; fields are only ever appended, so an older guard is a prefix): each
  fails before, migrates, keeps its limits and counters, and trades. Close then init works, for the oldest layout too.
- R3-2 (Low to Medium): a refused cancel at a 23:59 dip set last_seen low. Now a G10 cap needs a keeper
  (KeeperRequired, 6035), scripts/keeper.mjs checkpoints just after 00:00 UTC, the quickstart and demo setup name the
  owner's own key, and readings in the last hour before 00:00 UTC only raise the last equity seen that day. The audit's
  probe is refused both with the keeper's mark and without it.
- Red: notes/red-audit-r3.txt (6 of 6). Plants: 5, all caught (notes/planted-bug-r12.txt).

## Round 13 (Nov 21): audit round 4 (guardrail-audit-r4.md), tests in tests-litesvm/tests/audit_r4.rs

- 1 (Low): migrate_guard accepted pre-865 layouts that are not prefixes (Limits grew in the middle). Now only 865, 950,
  967 or 999 bytes migrate; anything else is refused (BadGuardAccount) and recovers with close_guard and init_guard.
- 2 (Low, residual R3-2): with the keeper missing its mark, a 22:59 dip or a 23:59 dip as the first call of that day
  still lowered the next baseline. Now the guard keeps the highest equity known per day (starting from that day's
  baseline, raised by every reading; three fields taken from the reserved bytes, so no migration) and a new day's
  baseline without the owner's or keeper's midnight mark is max(equity now, last equity seen, that high), all
  adjusted for deposits since. Consequence, stated in the README: without a mark the baseline never falls, so losses
  carry over until the keeper marks a day (the old "new day resets" test now uses the keeper's mark, and a new test
  shows the carry). The round-3 last-hour rule is subsumed by the day's high and was removed (its plant could no
  longer fail anything).
- 3 (Low): scripts/keeper.mjs now schedules by the chain's clock (getBlockTime), retries every 30 s until the guard's
  loss_day is the chain's day (up to --tries, default 60), logs each try and prints an ALERT if the day is not marked.
- 4 (Info): set_keeper(default) is refused while a cap is set; migrated guards with a cap must name a keeper (README),
  and the dashboard warns "No keeper set" for a capped guard without one.
- 5 (Info): the old-layout devnet guards are labelled "history (old layout, not migrated)" in the receipts and README.
- Red: notes/red-audit-r4.txt. Plants: 4 new, all caught; the R9 "ignores the last equity seen" plant is caught by a new
  test of a guard from before the day-high fields (notes/planted-bug-run.txt).
- Review of the day-high change: (a) a guard upgraded or migrated mid-day has no day high yet, so the last equity it saw
  earlier that day (perhaps a high) was not carried; now a day's high starts from that day's baseline and, on such a
  guard, from the last equity seen that day (red: notes/red-day-high-review.txt). (b) The order path's fallback baseline
  now uses the same rule as observe: one function, new_day_baseline (unit-tested), so the two cannot disagree. The
  fallback branch itself is not reached in the replay tests (observe sets the baseline first in every call); its plant
  sits on the shared function.
- Plant sites retargeted to the current code (several older sites had moved and the full run aborted at the first);
  scripts/planted-bug.sh now has CHECK=1 to confirm every site before a full run.

## Round 15 (Nov 22): audit round 5 and the final review panel (tests in tests-litesvm/tests/audit_r5.rs)

- The keeper and the agent must be different keys (set_keeper and set_agent refuse KeeperIsAgent, 6037).
- With no day high (a guard upgraded from e205a31), the stored previous day's baseline also counts, closing the
  upgrade-night case.
- The keeper trap: the owner's checkpoint resets the baseline (and the day's high) to the equity now at any time and
  emits a Checkpointed event; every checkpoint emits it (kind 0 max rule, 1 the keeper's midnight mark, 2 the owner's
  reset). The carry applies only from the previous UTC day: after a gap of more than one full day with no guard call,
  the baseline is the equity now. Without marks G10 acts as a drawdown cap from the last high seen until the owner
  resets it (README "Not claimed").
- Red: notes/red-audit-r5.txt (4 of 5; the previous-day carry twin passed before). Plants: 5 new.
- Final copy run before the last changes: 73 of 76 caught. Two survivors were real test gaps or redundancy: R9 (the
  previous day's last equity seen) now has a test where it is the only thing above the stored baseline
  (r5_with_no_day_high_the_previous_days_last_equity_seen_counts); R13's "day high starts from the baseline" became
  redundant once the stored previous day's baseline is carried, so that line and its plant were removed.
