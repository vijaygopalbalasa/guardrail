# Build and test

Back to the [README](../README.md).

## Build and test everything (the first build takes about 6 minutes cold)

Row Q needs only Node 22 or newer and a devnet wallet keypair file with about 0.1 devnet SOL (faucet.solana.com; a run uses about 0.05).
Steps 0 to 8 need Rust (step 7 also needs an OpenRouter key; CI skips it), solana-cli 4.2.x with cargo-build-sbf (platform-tools v1.54), Node 22 or newer, Python 3 and
network access to Solana devnet. Run every command from the repository root.

| Step | Command | What you should see |
|---|---|---|
| Q. Your own guard on devnet, Node only | `npm --prefix client ci && npm --prefix client run build && npm --prefix mcp ci && npm --prefix demo ci && node demo/quickstart.mjs --keypair <your devnet wallet.json>` | a Velocity account with 1,000 test dUSDT from Velocity's devnet faucet, a guard with the demo limits as its delegate, a fresh agent key, the cost (about 0.05 SOL, including 0.02 SOL for the agent's fees) and a link to your guard on the live dashboard |
| 0. Local key and config | `./scripts/init-local.sh` | a throwaway key in `keys/dev.json` and `config.yml` (your own solana config is not touched) |
| 1. Get Velocity's devnet binary | `solana -C config.yml program dump -u devnet vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P fixtures/velocity-devnet.so && (sha256sum fixtures/velocity-devnet.so 2>/dev/null || shasum -a 256 fixtures/velocity-devnet.so)` | the same hash as in `fixtures/velocity-devnet.so.sha256` |
| 2. Build the guard | `./scripts/build.sh` | ends with `Finished`; `target/deploy/guard.so` exists |
| 3. The headline replay | `(cd tests-litesvm && cargo test --release --test runaway -- --nocapture)` | both runs step by step, then the HEADLINE lines (41.2% vs 9.4%, breaches 0) |
| 4. Every limit test | `(cd tests-litesvm && cargo test --release)` | `47 passed` for the limit tests, plus the audit, daily-loss, probe, replay and sweep tests |
| 5. A local chain | `npm --prefix client ci && npm --prefix client run build && npm --prefix mcp ci && npm --prefix demo ci && ./scripts/local-validator.sh start` | prints a slot number: a validator with Velocity cloned from devnet and the guard |
| 6. An agent hitting the limits | `node demo/setup.mjs && node demo/agent.mjs runaway` | one line per tool call: accepted, or refused by G1, G3, G4 or G6, then a summary |
| 7. A language-model agent with a bad mandate | `OPENROUTER_API_KEY=... node demo/agent-llm.mjs runaway` (after step 6's setup) | each turn: the model's one-line reason, its tool call and the guard's verdict; logged to `out/llm-run-*.jsonl` |
| 8. The dashboard | `node client/scripts/demo-seed.mjs`, then `(cd dashboard && python3 -m http.server 8780)` and open the URL the seed printed | limits, accepted vs refused by rule, the last refusal, every decision; `/replay.html` plays the unguarded and guarded replays side by side, step by step |

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

### Live fills at the live price (local surfpool fork of mainnet)

Velocity's real mainnet program and state, the SOL and USDT oracles streamed from mainnet, and fills against copies of
real resting mainnet orders or Velocity's AMM. Only the owner's USDT (a surfpool cheatcode) and the fill crank (a
fork-only keeper key; `fill_perp_order` is permissionless) are the fork's own; nothing is sent to mainnet.

| Step | Command | What you should see |
|---|---|---|
| A. Fork mainnet and deploy the guard | `SURFPOOL=/path/to/surfpool ./scripts/surfpool-mainnet.sh start` (stop the devnet fork first: same ports) | "guard deployed, SOL and USDT oracles streamed from mainnet, clock following mainnet's slot" |
| B. A fork-only owner and guard | `node demo/mainnet-fork.mjs setup` | the owner, guard, agent and keeper keys (in `out/`) and their transactions |
| C. The language-model agent, live | `OPENROUTER_API_KEY=... node demo/mainnet-fork.mjs run --turns 8` | the program hash check, then each turn: the live price and oracle age, the best asks, the model's reason, the guard's verdict and any fill |

Recorded run: `notes/mainnet-fork-live.md`. Stop it with `./scripts/surfpool-mainnet.sh stop`.

## Dependencies

Install with `npm ci` (the lockfiles are committed and stay clean). `npm audit` reports 4 moderate findings in
`stream-json` and `uuid`, both pulled in by `@solana/web3.js` 1.x through `jayson` (its JSON-RPC client). The fix
npm offers is `@solana/web3.js` 3.x, a different API; here the RPC client talks only to an RPC endpoint you choose, and
neither finding is reachable from the guard program. The MCP server's `zod` is on 4.6.7, past the high-severity advisory.
