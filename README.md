# Guardrail

**"My AI trading bot blew up my account overnight."**

Guardrail: limits your AI trading agent cannot break. It is a Solana program that becomes the delegate of a Velocity
perps account. The agent can trade only through it, every order is checked on chain against limits the owner froze,
and the agent can never withdraw.

Live on Solana devnet: program [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](https://explorer.solana.com/address/BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy?cluster=devnet),
with a guarded agent's accepted order and its refusals by G1, G3, G4 and G6 on chain: `notes/devnet-receipts.md`.

Caveat on this first screen: devnet and local only, no real users. The guard wraps Velocity's `place_perp_order` and
`cancel_order` only. It does not wrap `place_and_take`, so the agent cannot take liquidity immediately at all; that
is a missing feature, not a bypass, because the agent's key has no direct path to the account.

## Headline (REPLAY on Velocity's real program)

The same runaway agent, the same falling market, run twice. The agent doubles a losing long every step and retries
with smaller orders when refused. SOL falls from $91.39 by 1% a step for 14 steps. Collateral: 1,000 dUSDT. The
unguarded run was stopped only by Velocity's own 5x margin check, after it had already reached 55 SOL.

| | Worst loss | Largest position | Leverage reached | Stopped by | Limit breaches |
|---|---|---|---|---|---|
| Unguarded (agent is Velocity's delegate) | **412.44 dUSDT (41.2%)** | 55 SOL | 6.98x | Velocity's own 5x margin check (88 orders refused) | n/a |
| Guarded | **94.47 dUSDT (9.4%)** | 10 SOL | 0.89x | the guard: 55 refused by G1, 50 by G4 | **0** |

"REPLAY" means: Velocity's real devnet binary running in LiteSVM, devnet state cloned on Nov 21 2026, the SOL price
written by the test at each step, and real fills from a second account. It is not live trading. A second guarded run
with a looser exposure cap lost 150.26 dUSDT (15.0%), refused by G1 and G3, also with 0 breaches. A breach means an
accepted order that left order size, worst-case exposure, leverage or daily notional over its cap at acceptance,
measured from the raw account bytes, not with the guard's own code. Full table: `notes/runaway-replay.txt`
(recorded); step 3 below writes a fresh copy to `out/runaway-replay.txt`.

## Try it in two minutes (the first build takes about 2 minutes more)

Needs Rust, solana-cli 4.2.x with cargo-build-sbf (platform-tools v1.54), Node 22 or newer, Python 3 and network
access to Solana devnet. Run every command from the repository root.

| Step | Command | What you should see |
|---|---|---|
| 0. Local key and config | `./scripts/init-local.sh` | a throwaway key in `keys/dev.json` and `config.yml` (your own solana config is not touched) |
| 1. Get Velocity's devnet binary | `solana -C config.yml program dump -u devnet vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P fixtures/velocity-devnet.so && (sha256sum fixtures/velocity-devnet.so 2>/dev/null || shasum -a 256 fixtures/velocity-devnet.so)` | the same hash as in `fixtures/velocity-devnet.so.sha256` |
| 2. Build the guard | `./scripts/build.sh` | ends with `Finished`; `target/deploy/guard.so` exists |
| 3. The headline replay | `(cd tests-litesvm && cargo test --release --test runaway -- --nocapture)` | both runs step by step, then the HEADLINE lines (41.2% vs 9.4%, breaches 0) |
| 4. Every limit test | `(cd tests-litesvm && cargo test --release)` | `46 passed` for the limit tests, plus the probes and the replay |
| 5. A local chain | `npm --prefix client install && npm --prefix client run build && npm --prefix mcp install && npm --prefix demo install && ./scripts/local-validator.sh start` | prints a slot number: a validator with Velocity cloned from devnet and the guard |
| 6. An agent hitting the limits | `node demo/setup.mjs && node demo/agent.mjs runaway` | one line per tool call: accepted, or refused by G1, G3, G4 or G6, then a summary |
| 7. A language-model agent with a bad mandate | `OPENROUTER_API_KEY=... node demo/agent-llm.mjs runaway` (after step 6's setup) | each turn: the model's one-line reason, its tool call and the guard's verdict; logged to `out/llm-run-*.jsonl` |
| 7. The dashboard | `node client/scripts/demo-seed.mjs`, then `(cd dashboard && python3 -m http.server 8780)` and open the URL the seed printed | limits, accepted vs refused by rule, the last refusal, every decision; `/replay.html` plays the unguarded and guarded replays side by side, step by step |

If the hash in step 1 differs, Velocity has upgraded its devnet program since Nov 21 2026 and its account layouts may
have moved; the committed hash is the version every test here was run against. Stop the validator with
`./scripts/local-validator.sh stop`.

Everything at once: `./scripts/test-all.sh`.

### Live fills at moving prices (local surfpool fork)

The local validator's oracle is frozen, so it shows refusals only. On a surfpool fork of devnet the SOL oracle can be
moved with surfpool's `surfnet_setAccount` cheatcode, so the same runaway agent gets real Velocity fills and a real
unrealized loss through MCP. It is a local fork with the price moved by the script, not live trading.

| Step | Command | What you should see |
|---|---|---|
| A. Get surfpool | download `surfpool` v1.7.0 for your platform from github.com/solana-foundation/surfpool releases | `surfpool --version` prints 1.7.0 |
| B. Fork devnet and deploy the guard | `SURFPOOL=/path/to/surfpool ./scripts/surfpool.sh start` | a Program Id line for the guard |
| C. Runaway agent, live fills | `RPC_URL=http://127.0.0.1:8997 node demo/live.mjs` | each step: SOL price, the guarded position and its unrealized PnL; the agent is held at the 6 SOL exposure cap |

Recorded run: `notes/surfpool-live.txt` (SOL $91.39 to $82.65, guarded position held at 6 SOL, unrealized PnL
-40.42 dUSDT on 1,000 collateral, 5 accepted, refused 33 by G4 and 21 by G1). Stop it with `./scripts/surfpool.sh stop`.

## What is real, with receipts

| Claim | Test | Where |
|---|---|---|
| A guarded runaway agent loses 9.4% where the same agent unguarded loses 41.2%, with 0 breaches | `replay_runaway_agent_unguarded_vs_guarded` | `tests-litesvm/tests/runaway.rs`, `notes/runaway-replay.txt` |
| When only leverage can bind (G1, G3 and G4 loose, G5 at 2x), the leverage cap stops the same runaway agent: 97 refusals by G5, worst loss 19.1% vs 41.2%, 0 breaches (shown red with G5 removed) | `replay_leverage_cap_binds_when_losses_shrink_equity` | `tests-litesvm/tests/runaway.rs`, `notes/g5-replay.txt`, `notes/red-g5-replay.txt` |
| The guard runs on devnet: deploy, init_guard, an accepted order, a cancel and refusals by G1, G3, G4 and G6 from the runaway agent through MCP, on Velocity devnet | explorer links | `notes/devnet-receipts.md`; dashboard on devnet: `notes/dashboard-devnet.png` |
| The audit's High finding (an Oracle order with no worst price) is refused, in replay and live on a surfpool fork | `f1_oracle_order_without_offset_cannot_fill_far_from_the_oracle`, `demo/f1-probe.mjs` | `tests-litesvm/tests/audit.rs`, `notes/surfpool-f1-probe.txt` |
| A refused order never reaches Velocity: the Velocity account stays byte-identical and exactly one refusal counter goes up | `every_refusal_leaves_velocity_untouched_and_bumps_exactly_one_counter` | `tests-litesvm/tests/limits.rs` |
| Each limit refuses an order over its cap, and an accepted twin that differs in one field passes | `g1_...` to `g9_...` and the other tests in the file (46 replay tests in all) | `tests-litesvm/tests/limits.rs` |
| Breaking any limit on purpose makes its own tests fail (45 planted bugs, 44 caught; the one not caught removes the post-CPI stored-order check, which the pre-check already makes unreachable, see `notes/RED.md`) | `scripts/planted-bug.sh` | `notes/planted-bug-run.txt`, `notes/planted-bug-r5.txt` |
| Tests were written first and failed before the code | red runs | `notes/RED.md`, `notes/red*-run.txt` |
| The limit math holds for 20,000 random cases per property | `math::props::*` | `programs/guard/src/math.rs` |
| The agent key cannot trade around the guard or withdraw | `g8_agent_cannot_withdraw_or_trade_around_the_guard` | `tests-litesvm/tests/limits.rs` |
| The guard's code reaches only Velocity's place and cancel instructions | `g8_guard_source_reaches_only_place_and_cancel_on_velocity`, `g8_guard_has_no_withdraw_or_delegate_instruction` | `tests-litesvm/tests/limits.rs` |
| A stranger cannot create the guard for someone else's account | `init_guard_requires_the_velocity_user_authority` | `tests-litesvm/tests/limits.rs` |
| An agent framework can trade through MCP and never change limits (the server has exactly three tools) | MCP test | `mcp/test/mcp.test.mjs` |
| The scripted runaway agent ends within the exposure cap, refused by every rule it runs into | demo test | `demo/test/agent.test.mjs` |
| A language-model agent (anthropic/claude-haiku-5.5 through OpenRouter) told to "build a 25 SOL long and buy every dip" is held at the 6 SOL cap: G1 refuses 5 SOL, G4 refuses the order that would pass 6 SOL, on the local validator, a surfpool fork with real fills and devnet | recorded transcripts, replayed offline with no API call | `notes/llm-agent.md`, `demo/test/llm-replay.test.mjs` |
| With a softer instruction ("recover the loss before the close"), both models tested declined to add risk and exited instead; only the blunt mandate made them push, and that is when the guard refused | recorded transcripts | `notes/llm-agent.md` |
| The dashboard ignores events from other programs, refuses accounts with the wrong owner and renders data as text | security test | `dashboard/test/security.test.mjs` |

## Not claimed

- Devnet and local only. Nothing here runs on mainnet, and there are no real users yet.
- Velocity is upgradeable and the guard depends on it: its account layouts, instructions and delegate rules.
- The owner can always bypass the guard by trading directly on Velocity or removing the delegate. Only the agent is bound.
- Fills and moving prices are shown in replays and on a local surfpool fork where a cheatcode moves the oracle, because Velocity's devnet oracle is stale. On the local validator the
  cloned oracle is a frozen snapshot, so orders rest but do not fill there.
- The demo agent's runs on the local validator do not fill (frozen oracle), so its numbers are refusals, not PnL.
- The guard places orders through Velocity's `place_perp_order` (resting and auction orders). It does not wrap
  `place_and_take`.
- Collateral is counted from the quote deposit only; any other spot balance blocks new risk instead of being valued.
- Daily-loss and open-order-count limits are not built.

## How it compares

- **Xorr** enforces its daily cap and allowlist inside its own off-chain executor for spot buys, with only the total
  spend enforced on chain by a token approval.
- **CRESCO** is a generic on-chain mandate for token transfers.
- **Velocity's equity floor** exists, but only Velocity's admin can set it; the account's owner and delegate cannot.
- **Guardrail** is enforced on chain, by the program that holds the delegate role, on every perps order: order size,
  markets, daily notional, worst-case exposure including open orders, leverage on unrealized PnL, and the price
  band. The agent's key has no other path to the account.

## The limits

| | Limit | In one line |
|---|---|---|
| G0 | Setup and agent | Only the Velocity account's owner can create its guard, and only the agent key the owner named can trade through it; a revoked or different key is rejected. |
| G1 | Order size | No single order larger than the owner's maximum. |
| G2 | Allowlists | Only the owner's markets and order types (Limit, Market, Oracle); no trigger orders, no builder fees, no odd order flags. |
| G3 | Daily notional | Total order value per UTC day stays under the cap; a new day starts a new total. |
| G4 | Worst-case exposure | Position plus every open order on one side plus this order stays under the cap for that market. |
| G5 | Leverage | Worst-case notional across the account, over collateral plus unrealized PnL, stays under the cap. |
| G6 | Price band | Every price on the order stays within a band around the market's own oracle, and the oracle must be fresh. |
| G7 | Owner controls | Only the owner sets limits, rotates or revokes the agent, and pauses. |
| G8 | No withdraw | The guard has no withdraw path and reaches only Velocity's place and cancel instructions. |
| G9 | Exits and cancels | Cancels always go through; an exit that only shrinks the position skips G1 to G5 and the pause but stays inside the band, and with a very stale oracle it may only be priced in the owner's favour. |

A refused order is a successful transaction that records the rule, the measured value and the owner's cap, and
emits an `OrderChecked` event. Nothing reaches Velocity. Real errors (wrong agent, bad accounts, a stale oracle on a
new order, Velocity's own errors) still fail.

## Use it from any agent framework (MCP)

`mcp/server.mjs` holds only the agent's key and exposes three tools: `guardrail_place_order`,
`guardrail_cancel_order` and `guardrail_status`. There is no tool to change limits, rotate the agent, unpause or
withdraw.

```json
{
  "mcpServers": {
    "guardrail": {
      "command": "node",
      "args": ["/path/to/guardrail/mcp/server.mjs"],
      "env": {
        "GUARDRAIL_RPC_URL": "http://127.0.0.1:8999",
        "GUARDRAIL_AGENT_KEYPAIR": "/path/to/agent-keypair.json",
        "GUARDRAIL_OWNER": "<the Velocity account owner's public key>"
      }
    }
  }
}
```

TypeScript: `@guardrail/client` (`client/`) has `placeOrder`, which returns `{ accepted, rule, value, cap, reason }`,
plus `cancelOrder` and `getGuard`.

## Architecture

```
owner --(once: init_guard, set_limits, set_agent, set_paused; Velocity update_user_delegate)--+
                                                                                            v
agent --> MCP server or @guardrail/client --> guard program --(CPI, PDA signs as the delegate)--> Velocity place_perp_order / cancel_order
                                                  |
                                                  +- checks G0 to G9 before the CPI, reading the Velocity account, the market and its oracle
                                                  +- refuses: records counters and last_refusal, emits OrderChecked, Velocity untouched
                                                  +- accepts: forwards the order, re-reads the account after the CPI and asserts the caps
dashboard --> reads the Guard account and its OrderChecked events from the RPC
```

- `programs/guard/`: the Anchor program (`lib.rs` checks and CPI, `math.rs` limit math, `velocity.rs` Velocity
  account layouts).
- `tests-litesvm/`: replay tests on Velocity's real binary.
- `client/`, `mcp/`, `demo/`, `dashboard/`: the TypeScript client, the MCP server, the scripted agent and the dashboard.
