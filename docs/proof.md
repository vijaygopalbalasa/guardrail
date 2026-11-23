# Proof: replays, the sweep and receipts

Back to the [README](../README.md).

## Headline (REPLAY on Velocity's real program)

The same runaway agent, the same falling market, run twice. The agent doubles a losing long every step and retries
with smaller orders when refused. SOL falls from $91.39 by 1% a step for 14 steps, plus a final mark 1% lower ($79.39, a 13% fall), where the worst loss is measured. Collateral: 1,000 dUSDT. The
unguarded run was stopped only by Velocity's own margin check, which refuses new orders above 5x, after it had already
reached 55 SOL; the held position then drifted to 6.98x as the price fell.

| | Worst loss | Largest position | Leverage reached | Stopped by | Limit breaches |
|---|---|---|---|---|---|
| Unguarded (agent is Velocity's delegate) | **412.44 dUSDT (41.2%)** | 55 SOL | 6.98x | Velocity's own 5x margin check (88 orders refused) | n/a |
| Guarded | **94.47 dUSDT (9.4%)** | 10 SOL | 0.89x | the guard: 55 refused by G1, 30 by G4, 20 by G10 (daily loss) | **0** |

"REPLAY" means: Velocity's real devnet binary running in LiteSVM, devnet state cloned on Nov 21 2026, the SOL price
written by the test at each step, and real fills from a second account. It is not live trading. A second guarded run
with a looser exposure cap lost 150.26 dUSDT (15.0%), refused by G1, G3 and G10, also with 0 breaches. With every
limit loose except the daily-loss brake (G10 at 20 dUSDT a day), it lost 140.06 dUSDT (14.0%): 98 refusals by G10,
0 breaches. The brake stops new risk once the day's loss passes the cap; it does not close a position, so a held
position keeps losing as the price falls. The guarded run above carries G10 at 50 dUSDT a day. A breach means an
accepted order that left order size, worst-case exposure, leverage or daily notional over its cap at acceptance, or
was accepted while the day's loss was over the G10 cap,
measured from the raw account bytes, not with the guard's own code. Full table: `notes/runaway-replay.txt`
(recorded); step 3 below writes a fresh copy to `out/runaway-replay.txt`.

## A normal agent: 30 random paths (REPLAY)

Not every bot is a runaway. `tests-litesvm/tests/sweep.rs` runs a plain grid bot (2 SOL at each 1% level below the
start, sell one level up, orders within 3% of the price, never doubles) on 30 seeded random paths of 60 steps (1.2% a
step), unguarded and guarded, on Velocity's real binary with fills when the price passes through an order.

| | Median worst loss | Worst path | Limit breaches |
|---|---|---|---|
| Unguarded | 1.1% | 26.6% (seed 18, SOL -20.5%) | n/a |
| Guarded (G1 4 SOL, G4 30 SOL, G5 1.5x, G6 2%, G10 100 dUSDT a day) | 1.1% | 22.6% | **0** |

On calm paths the guard changes nothing, so the honest headline is the same median loss. It refused 493 orders by G6
on all 30 paths, by construction: the bot keeps orders up to 3% away and the band is 2% (119 of those were sells). It
refused 111 buys by G5 (leverage) on seeds 3, 4, 7, 8, 18, 19, 23, 25, 28 and 30, the paths that fell 8% or more; no
sell was refused by G5. G10 did not bind: once the price was below the grid, the bot stopped buying on its own.

When the limits fit the bot (the same paths with the G6 band at 4%, wider than its 3% window), it is refused only by
G5, on the same 10 falling paths (181 of 743 orders it asked for), and never on the other 20. Median worst loss 1.1%,
worst path 22.6%, 0 breaches. Full table with fills per run: `notes/sweep.txt`.

## What is real, with receipts

| Claim | Test | Where |
|---|---|---|
| A guarded runaway agent loses 9.4% where the same agent unguarded loses 41.2%, with 0 breaches | `replay_runaway_agent_unguarded_vs_guarded` | `tests-litesvm/tests/runaway.rs`, `notes/runaway-replay.txt` |
| When only leverage can bind (G1, G3 and G4 loose, G5 at 2x), the leverage cap stops the same runaway agent: 97 refusals by G5, worst loss 19.1% vs 41.2%, 0 breaches (shown red with G5 removed) | `replay_leverage_cap_binds_when_losses_shrink_equity` | `tests-litesvm/tests/runaway.rs`, `notes/g5-replay.txt`, `notes/red-g5-replay.txt` |
| The daily-loss brake (G10) refuses new risk once the day's loss passes the owner's cap, while exits and cancels pass; a new UTC day resets it, and deposits and withdrawals are neutral. When it is the only tight limit, it stops the runaway agent with 98 refusals and a 14.0% worst loss vs 41.2% (it does not close the held position) | `tests-litesvm/tests/daily_loss.rs`, `replay_runaway_agent_unguarded_vs_guarded` | `notes/runaway-replay.txt`, `notes/red-g10.txt`, `notes/planted-bug-r6.txt` |
| A normal grid bot on 30 seeded random paths keeps the same median loss guarded and unguarded (1.1%), 22.6% vs 26.6% on the worst path, 0 breaches on every path; G5 binds on the 10 paths that fell 8% or more, G6 on all 30 (the bot's 3% window is wider than the 2% band) | `sweep_grid_agent_on_30_random_paths` | `tests-litesvm/tests/sweep.rs`, `notes/sweep.txt`, `notes/sweep.json` |
| The agent cannot go around the guard on public devnet: with its own key, a direct Velocity order, a withdraw and a delegate change all fail on chain ([order](https://explorer.solana.com/tx/3R6bp6TxN4SuXUMGkrMPf5mk36EDsZr5oR5pzREVtjM9QCbWtdU5mCQYEoDxDZbHdp12qc3YYfF9yMM36D5zeKAa?cluster=devnet), [withdraw](https://explorer.solana.com/tx/MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3?cluster=devnet), [delegate](https://explorer.solana.com/tx/2MuwW1j9gLr1dJJVsxizxWCGfW2AuVYV9WwhbXTXPiuBLTd34X3hJe7WqNUjtoszCDGhK8X7hkpCnJxhTSm6ugiQ?cluster=devnet)) | `demo/bypass-attempt.mjs` | `notes/devnet-receipts.md` ("The agent tried to go around the guard") |
| The guard runs on devnet: deploy, init_guard, an accepted order, a cancel and refusals by G1, G3, G4 and G6 from the runaway agent through MCP, on Velocity devnet; a fresh guard (HMwVJCoz...) took 31 refusals from the scripted runaway agent (G1 10, G3 3, G4 3, G6 15), each a devnet transaction listed in the receipts | `demo/devnet-runaway.mjs`, explorer links | `notes/devnet-receipts.md`; dashboard on devnet: `docs/dashboard.png` |
| The hosted dashboard reads the guard from devnet RPC (the language-model agent's guard, each order linked to its transaction) | [guardrail-perps.vercel.app](https://guardrail-perps.vercel.app) | `dashboard/` (the site is a copy of it) |
| The audit's High finding (an Oracle order with no worst price) is refused, in replay and live on a surfpool fork | `f1_oracle_order_without_offset_cannot_fill_far_from_the_oracle`, `demo/f1-probe.mjs` | `tests-litesvm/tests/audit.rs`, `notes/surfpool-f1-probe.txt` |
| A refused order never reaches Velocity: the Velocity account stays byte-identical and exactly one refusal counter goes up | `every_refusal_leaves_velocity_untouched_and_bumps_exactly_one_counter` | `tests-litesvm/tests/limits.rs` |
| Each limit refuses an order over its cap, and an accepted twin that differs in one field passes | `g1_...` to `g9_...` and the other tests in the file (47 tests in the file) | `tests-litesvm/tests/limits.rs` |
| 74 of 75 planted bugs caught (copy run at b779468); the one not caught is a backup check (the post-CPI stored-order check) that the earlier checks make unreachable, see `notes/RED.md` | `scripts/planted-bug.sh` (run in a copy-on-write copy) | `notes/planted-bug-run.txt`, `notes/planted-bug-summary.txt` |
| Tests were written first and failed before the code | red runs | `notes/RED.md`, `notes/red*-run.txt` |
| The limit math holds for 20,000 random cases per property | `math::props::*` | `programs/guard/src/math.rs` |
| The agent key cannot trade around the guard or withdraw | `g8_agent_cannot_withdraw_or_trade_around_the_guard` | `tests-litesvm/tests/limits.rs` |
| The guard's code reaches only Velocity's place and cancel instructions | `g8_guard_source_reaches_only_place_and_cancel_on_velocity`, `g8_guard_has_no_withdraw_or_delegate_instruction` | `tests-litesvm/tests/limits.rs` |
| A stranger cannot create the guard for someone else's account | `init_guard_requires_the_velocity_user_authority` | `tests-litesvm/tests/limits.rs` |
| An agent framework can trade through MCP and never change limits (the server has exactly three tools) | MCP test | `mcp/test/mcp.test.mjs` |
| The scripted runaway agent ends within the exposure cap, refused by every rule it runs into | demo test | `demo/test/agent.test.mjs` |
| On a local fork of Solana mainnet (Velocity's real mainnet program and state, the SOL oracle streamed live, copies of real resting orders; nothing sent to mainnet), the language-model agent fills to exactly its 6 SOL cap: 2.75 SOL filled, 22.25 SOL refused by G1, 4 SOL refused by G4, 3.25 SOL filled against a real mainnet maker's order and Velocity's AMM, then it stops | `demo/mainnet-fork.mjs run` (one unbroken screen recording, `client/test/mainnet-fork.record.mjs`) | `notes/mainnet-fork-live.md`, `notes/mainnet-fork-live.txt`, `notes/llm-transcript-runaway-mainnet-fork.jsonl` |
| A language-model agent (anthropic/claude-haiku-5.5 through OpenRouter) told to "build a 25 SOL long and buy every dip" is held at the 6 SOL cap: G1 refuses 5 SOL, G4 refuses the order that would pass 6 SOL, on the local validator, a surfpool fork with real fills and devnet | recorded transcripts, replayed offline with no API call | `notes/llm-agent.md`, `demo/test/llm-replay.test.mjs` |
| With a softer instruction ("recover the loss before the close"), both models tested declined to add risk and exited instead; only the blunt mandate made them push, and that is when the guard refused | recorded transcripts | `notes/llm-agent.md` |
| The dashboard ignores events from other programs, refuses accounts with the wrong owner and renders data as text | security test | `dashboard/test/security.test.mjs` |

## Not claimed

- Devnet and local only (one run on a local fork of mainnet). Nothing is deployed or sent to mainnet, and there are no
  real users yet.
- Velocity is upgradeable and the guard depends on it: its account layouts, instructions and delegate rules.
- The owner can always bypass the guard by trading directly on Velocity or removing the delegate. Only the agent is bound.
- Fills are shown in replays, on a local fork of mainnet (live oracle, real resting orders; a fork-only keeper sends
  Velocity's permissionless fill, `notes/mainnet-fork-live.md`) and on a local fork of devnet where a cheatcode moves the
  oracle, because Velocity's devnet oracle is stale. On the local validator the
  cloned oracle is a frozen snapshot, so orders rest but do not fill there.
- The demo agent's runs on the local validator do not fill (frozen oracle), so its numbers are refusals, not PnL.
- The guard places orders through Velocity's `place_perp_order` (resting and auction orders). It does not wrap
  `place_and_take`.
- Collateral is counted from the quote deposit only; any other spot balance blocks new risk instead of being valued.
- If the owner removes a market from the allowlist while a position is open, the agent can no longer exit it (exits keep
  G2); the owner exits that position directly.
- Without keeper marks, G10 acts as a drawdown cap from the last high seen until the owner resets it (the owner's
  checkpoint resets it at any time; after more than a full day with no guard call it starts again from the equity then).
- G10 values deposits and withdrawals at the quote oracle and counts collateral 1:1, so a deposit made while the
  stablecoin is off $1 shows as a small gain or loss (a depeg caveat).
