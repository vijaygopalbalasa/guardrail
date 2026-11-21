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
