# Guardrail

**"My AI trading bot blew up my account overnight."**

![LOCAL FORK OF SOLANA MAINNET: the language-model agent asks for 22.25 SOL (refused, order size), then 4 SOL (refused, exposure), then fills 3.25 SOL to sit at exactly its 6 SOL cap; the dashboard shows 2 refused on chain](docs/mainnet-fork.png)

- **Exactly the 6 SOL cap on a local fork of Solana mainnet**: Velocity's real mainnet program, the live SOL oracle and
  real resting orders (nothing is sent to mainnet). The language-model agent told to build a 25 SOL long filled 2.75 SOL,
  was refused on chain at 22.25 SOL (order size) and at 4 SOL (exposure), filled 3.25 SOL against a real mainnet maker's
  order and Velocity's AMM, then stopped: "I won't try to route around it" (`notes/mainnet-fork-live.md`).
- **3 of 3 bypass attempts fail on public devnet**: with its own key, the agent's direct Velocity
  [order](https://explorer.solana.com/tx/3R6bp6TxN4SuXUMGkrMPf5mk36EDsZr5oR5pzREVtjM9QCbWtdU5mCQYEoDxDZbHdp12qc3YYfF9yMM36D5zeKAa?cluster=devnet), [withdraw](https://explorer.solana.com/tx/MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3?cluster=devnet) and [delegate change](https://explorer.solana.com/tx/2MuwW1j9gLr1dJJVsxizxWCGfW2AuVYV9WwhbXTXPiuBLTd34X3hJe7WqNUjtoszCDGhK8X7hkpCnJxhTSm6ugiQ?cluster=devnet) are refused by Velocity (`demo/bypass-attempt.mjs`).
- **41.2% vs 9.4%** ([chart](docs/replay.png)): a scripted runaway bot that doubles a losing long on a 13% fall ($91.39 to $79.39), unguarded vs through Guardrail, with 0
  limit breaches (a replay on Velocity's real program). Guarded caps: 4 SOL per order, 10 SOL worst-case exposure,
  1,500 dUSDT a day, 2x leverage, 2% band, 50 dUSDT daily loss. Unguarded, only Velocity's margin rules applied and the
  agent reached 6.98x leverage.
- **54 orders refused**: on a local fork of devnet with real fills, the agent was held at its 6 SOL cap while SOL fell.
  On public devnet, where orders rest without fills, a fresh guard refused the same agent's orders 31 times
  ([guard](https://guardrail-perps.vercel.app/?rpc=https://api.devnet.solana.com&guard=HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg); every transaction in `notes/devnet-receipts.md`).
- **1.1% median loss either way**: a normal grid bot on 30 random price paths is barely touched by the guard; its worst
  path loses 22.6% guarded vs 26.6% unguarded.

Guardrail is a Solana program that becomes the delegate of a Velocity perps account (Velocity is a perps exchange on
Solana, Drift's successor). The agent trades only through it,
every order is checked on chain against limits the owner sets, and the agent can never place an order past them or
withdraw. Leverage can still drift with price after an order is placed (2.17x against a 2.0x cap in the leverage-only
replay). Velocity's margin check (it refuses new orders above 5x; a held position can drift past that as the price falls,
as the unguarded run did at 6.98x) is liquidation protection; Guardrail is the owner's risk budget.

| Try it | Command | What you see |
|---|---|---|
| 1. The agent's recorded devnet run (no key, no SOL, no install) | `node demo/replay-llm.mjs` | each turn: the model's own words, the order it asked for, the guard's verdict and the devnet transaction |
| 2a. Your own guard in the browser (a devnet wallet such as Phantom, about 0.06 devnet SOL) | [guardrail-perps.vercel.app/setup.html](https://guardrail-perps.vercel.app/setup.html) | connect, open a Velocity account with 1,000 test dUSDT, pick Cautious, Balanced or Loose, download the agent key, create the guard (two signatures), copy the MCP settings |
| 2b. Your own guard on devnet from Node (about 0.2 devnet SOL) | `npm --prefix client ci && npm --prefix client run build && npm --prefix mcp ci && npm --prefix demo ci && node demo/quickstart.mjs --keypair <devnet wallet.json>`, then `node demo/try-mcp.mjs` | a Velocity account with test dUSDT, a guard with demo limits, the MCP settings to paste into your agent, then your agent key's over-limit order refused on chain and an in-limit order accepted, each with its explorer link |
| 3. The live dashboard | [guardrail-perps.vercel.app](https://guardrail-perps.vercel.app) and [/replay.html](https://guardrail-perps.vercel.app/replay.html) | the fills run, the devnet guard read live, and the replay |

Devnet only, no real users yet. Five internal review rounds; every finding and fix is in the repo (`audits/`). The owner
can always trade directly or remove the delegate. The guard wraps Velocity's `place_perp_order` and `cancel_order`, not
`place_and_take`, so the agent cannot take liquidity immediately; that is a missing feature, not a bypass, and wrapping
it is next.

## What the guard cannot do

- **Close positions.** G10, the daily loss brake, stops new risk; it does not close anything. A held position keeps
  losing if the price keeps falling.
- **Bind the owner.** The owner can trade directly on Velocity or remove the delegate at any time. Only the agent is bound.
- **Hold leverage under the cap as prices move.** Caps are checked when an order is placed; afterwards leverage moves
  with the price.
- **Outlive Velocity's changes.** Velocity is upgradeable; the guard depends on its account layouts and instructions.
- **Value other collateral.** Only the quote deposit counts; any other spot balance blocks new risk.
- **Run G10 unattended.** The daily loss brake needs a keeper at 00:00 UTC (`scripts/keeper.mjs`); without marks it acts
  as a drawdown cap from the last high seen until the owner resets it.

## More

- [Proof](docs/proof.md): the headline replay table, the 30-path sweep, every claim with its test and receipt, and
  what is not claimed.
- [The limits in full](docs/limits.md): G0 to G10, the daily loss brake in detail, upgrades and migration.
- [Build and test](docs/build-and-test.md): every step from a fresh clone (about 6 minutes cold), the local validator,
  the surfpool forks with live fills (devnet with a moved price, and mainnet with the live price) and the CI job.
- Devnet program [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](https://explorer.solana.com/address/BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy?cluster=devnet)
  (built from commit ca98f09; the deployed bytes match the build, `scripts/verify-devnet-program.sh`) and its
  receipts: `notes/devnet-receipts.md` (old-layout guards are labelled "history (old layout, not migrated)"; the freshness
  check is relaxed on devnet, whose oracle is weeks old).
- Review rounds: `audits/`; the fixes round by round: `notes/RED.md`.
- [Mainnet readiness](docs/mainnet.md): not deployed; the cost (about 1.82 to 1.95 SOL of recoverable rent), the steps,
  `scripts/deploy-mainnet.sh` (a dry run unless given a mainnet key, an upgrade-authority plan and `--yes`) and the risks.

## The limits

| | Limit |
|---|---|
| G0 | Only the account's owner creates the guard; only the named agent trades through it. |
| G1 | Order size. |
| G2 | Allowed markets and order types; no trigger orders, builder fees or odd flags. |
| G3 | Daily notional. |
| G4 | Worst-case exposure per market, open orders included. |
| G5 | Leverage on collateral plus unrealized PnL. |
| G6 | Price band around the market's own oracle, with a fresh oracle. |
| G7 | Only the owner sets limits, rotates or revokes the agent, and pauses. |
| G8 | No withdraw: the guard reaches only Velocity's place and cancel. |
| G9 | Exits that only shrink the position and cancels always go through, inside the band. |
| G10 | Daily loss brake: stops new risk, does not close positions. |

The full rules: [docs/limits.md](docs/limits.md).

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

## How it compares

- **Xorr** enforces its daily cap and allowlist inside its own off-chain executor for spot buys, with only the total
  spend enforced on chain by a token approval.
- **CRESCO** is a generic on-chain mandate for token transfers.
- **Velocity's equity floor** exists, but only Velocity's admin can set it; the account's owner and delegate cannot.
- **Guardrail** is enforced on chain, by the program that holds the delegate role, on every perps order: order size,
  markets, daily notional, worst-case exposure including open orders, leverage on unrealized PnL, and the price
  band. The agent's key has no other path to the account.

## Architecture

```
owner --(once: init_guard, set_limits, set_agent, set_paused; Velocity update_user_delegate)--+
                                                                                            v
agent --> MCP server or @guardrail/client --> guard program --(CPI, PDA signs as the delegate)--> Velocity place_perp_order / cancel_order
                                                  |
                                                  +- checks G0 to G10 before the CPI, reading the Velocity account, the market and its oracle
                                                  +- refuses: records counters and last_refusal, emits OrderChecked, Velocity untouched
                                                  +- accepts: forwards the order, re-reads the account after the CPI and asserts the caps
dashboard --> reads the Guard account and its OrderChecked events from the RPC
```

- `programs/guard/`: the Anchor program (`lib.rs` checks and CPI, `math.rs` limit math, `velocity.rs` Velocity
  account layouts).
- `tests-litesvm/`: replay tests on Velocity's real binary.
- `client/`, `mcp/`, `demo/`, `dashboard/`: the TypeScript client, the MCP server, the scripted agent and the dashboard.
