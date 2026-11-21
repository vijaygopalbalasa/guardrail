# Guardrail: spec v1 (Solana Perps and Prediction Markets; deadline 2026-12-05 21:00 UTC)

One line: limits your AI trading agent cannot break.
The fear: "My AI trading bot blew up my account overnight."
Headline number (to measure): the same agent and the same market replay, unguarded vs guarded: worst loss, orders refused,
limit breaches (target: zero breaches guarded).

## What it is
A guard program on Solana that becomes the delegate of a user's Velocity perps account (Velocity v1 is Drift's successor;
a delegate can trade but cannot withdraw). The user freezes limits on chain. The AI agent's key can only trade through the
guard; every order is checked against the limits before it reaches Velocity; an order that breaks a limit is refused on chain
with the reason. The owner keeps full control (trade directly, change limits, revoke the agent, remove the delegate).

## Limits (each test-first, each refusal with an accepted twin that differs in one field)
- G1 max order size per order (base amount) [proven in spike].
- G2 market allowlist (market_index) and order-type allowlist; builder_idx and builder_fee must be None.
- G3 daily notional cap: running total of order notional per UTC day kept in the Guard account; refuse when exceeded.
- G4 max worst-case exposure per market: an order rests and fills later in someone else's transaction, so cap
  position + all open orders on that market's side + this order (read from the Velocity User account before the CPI:
  perp positions at offset 424, 80 bytes each, base_asset_amount at +8; use the position's open bid/ask totals if the
  struct has them, otherwise sum the 32 order slots). Refuse if it exceeds the cap.
- G5 leverage cap on the same worst-case exposure: (worst-case notional at the oracle price) / collateral; refuse above.
- G6 price band: limit prices and oracle offsets must stay within N bps of the oracle price.
- G7 owner-only: set or change limits, rotate or revoke the agent, pause; the agent can never change limits.
- G9 cancels and reduce-only orders are ALWAYS allowed (a guard must never trap an agent in a losing position); test it.
- G0 setup safety: init_guard requires the Velocity User's authority == the signing owner (no PDA squatting); the agent
  check lives in the account constraints (agent set and equal to the signer).
- G8 withdraw is impossible through the guard (no such instruction; Velocity Withdraw is has_one = authority).
Every accepted or refused order emits an event (limit, value, reason) for the dashboard. A limit refusal is a SUCCESSFUL
transaction that does not call Velocity and increments per-limit refusal counters in the Guard account (durable on-chain
record); real errors and the after-CPI cap assertion still fail the transaction. G10 (stretch): daily loss cap.
Decided defaults (Nov 21): G9 bypass only for reduce-only orders opposing the position with size <= |position|; cancels
always allowed; breach = accepted order leaving G3/G4/G5 over cap (price drift reported separately); G4 in base units per
market (market table = G2 allowlist); G5 whole account, collateral = spot0 only; guard exposes place and cancel only.

## Proof and demo
- Unit and integration tests (LiteSVM with Velocity's real binary and cloned state), property tests on the limit math,
  planted-bug checks (break each limit, its test fails).
- Fills harness: local validator cloned from MAINNET (fresh oracles) with our own maker account, so real positions exist and
  G3 to G6 are exercised with fills.
- Demo agent: a small AI trading agent (LLM decides orders from prices) with a planted runaway loop; run unguarded and
  guarded on the same replay; record losses and refusals.
- Devnet deploy of the guard (resting orders on Velocity devnet; its oracle is stale, so fills are shown on the mainnet fork).
- Dashboard: limits, live orders, every refusal with its reason, the headline number.
- Drop-in wrapper: a small TypeScript client (`guardrail.placeOrder(...)`) so any agent framework can route orders through it.

