# Guardrail phase A: red, green and planted bugs (2026-11-21)

All runs are REPLAYS: Velocity's real devnet binary (sha256 in fixtures/velocity-devnet.so.sha256) in LiteSVM 0.18.2,
devnet state cloned Nov 21 2026, oracle prices written by the tests, real fills from a flow account.

## Red
- Limit tests (tests-litesvm/tests/limits.rs) against the stub (every handler empty): 29 of 30 failed. The pass was the
  direct-bypass test, which exercises Velocity's own constraint. Output: notes/red-run.txt.
- Math property tests against the stub math: 9 of 11 failed (the two passes are soundness properties that hold
  vacuously; each is paired with a completeness property that failed). Output: notes/red-math-run.txt.

## Green
- 31 limit tests pass (notes/green-run.txt); 11 math tests pass, 20,000 cases per property.
- Probe of Velocity itself (tests/probe.rs, notes/probe-velocity.txt): reduce-only orders are accepted at placement in
  any direction and counted in open_bids/open_asks; at fill time Velocity clamps them so a position never flips.

## Planted bugs (scripts/planted-bug.sh, notes/planted-bug-run.txt)
Each plant breaks one limit; every plant is caught, and only tests that depend on that limit fail:
G1 off by one; G2 market index ignored, order-type check removed, builder check removed; G3 running total forgotten,
never resets on a new day; G4 ignores this order, first-match slot lookup; G5 ignores unrealized PnL, check removed;
G6 limit band skipped, auction band skipped, oracle offset skipped, staleness off by one; G7 pause ignored, owner check
removed, revoked agent still trades; G9 exit need not oppose the position, exits blocked by limits; G8 a third Velocity
discriminator appears; post-trade check off by one. Sources are restored from a copy and compared byte for byte.

## Runaway replay (tests/runaway.rs, notes/runaway-replay.txt)
Same agent loop and price path, unguarded vs guarded; headline lines at the end of the report.
