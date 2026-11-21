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
