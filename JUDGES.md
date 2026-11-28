# Guardrail in five minutes

Guardrail is a Solana program that sits between an AI trading agent and its Velocity perps account. The agent's key can
trade only through it; every order is checked on chain against the owner's limits, and the agent has no way to withdraw.
Everything below is on public devnet or in this repository. Testnet only; no outside users have run the live path yet.

## 1. One minute, nothing to install

`node demo/replay-llm.mjs` (no key, no SOL, no `npm install`): the language-model agent's recorded devnet run, turn by
turn: what the model said, the order it asked for, the guard's verdict and the devnet transaction.

## 2. One minute, three links

- An order over the per-order limit, [refused on chain](https://explorer.solana.com/tx/3Nejq2iEaLGW5yPmuq7UTcs6J41Ch3wqrseUYxAVgFjcsXau4cM8HrEx4vYu2HXwahyH1W1yJ3qz9vsYiWbs3vvh?cluster=devnet) for a brand-new wallet's guard (ours).
- The agent's own key trying to [withdraw](https://explorer.solana.com/tx/MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3?cluster=devnet) around the guard, refused by Velocity.
- The [live dashboard](https://guardrail-perps.vercel.app): limits, accepted and refused orders with their reasons, and the
  [replay](https://guardrail-perps.vercel.app/replay.html) of a runaway bot, unguarded vs guarded.

## 3. Three minutes, your own guard (Node 22, about 0.1 devnet SOL)

```sh
git clone https://github.com/vijaygopalbalasa/guardrail && cd guardrail
npm --prefix client ci && npm --prefix client run build && npm --prefix mcp ci && npm --prefix demo ci
node demo/quickstart.mjs --keypair <devnet wallet.json>   # a Velocity account, a guard with demo limits, an agent key
node demo/try-mcp.mjs                                     # as the agent, over MCP: 8 answers, each checked
node demo/bypass-attempt.mjs                              # the agent's own key: 3 of 3 attempts refused
```

No devnet SOL? `faucet.solana.com` (web). Faucet dry? Open an issue with your devnet address and I will send 0.1 devnet SOL.
What a run looks like on Linux from a fresh clone: `notes/linux-fresh-wallet-nov28.txt`.

## Where each limit is proven

| Limit | Public devnet (orders rest, never fill) | With fills or in tests |
|---|---|---|
| G1 order size | [refused](https://explorer.solana.com/tx/2wVqpYBxPaypu8WAwDoZsjXh6QDh9rHdoQG91sk1J3mLQuPXBgDhHq3tkBrd7XEckZ6T2p5r28wkHw1noFvfpnBV?cluster=devnet) | mainnet fork, 22.25 SOL refused (`notes/mainnet-fork-live.md`) |
| G2 markets and order types | [market order refused](https://explorer.solana.com/tx/2nrTeju6BGPM2xACV1vMbiutdsQxouenGUaYc9tX7Ly2FXWgJNxPeCPTcie6iX4LQanFSd8hKMvwZ4eW7mWFaduA?cluster=devnet) | tests (`notes/RED.md`) |
| G3 daily notional | try-mcp skips its in-limit order when today's cap is used | runaway replay, 12 refused (`notes/runaway-replay.txt`) |
| G4 worst-case exposure (resting orders count) | [6.5 SOL refused at a 6 SOL cap](https://explorer.solana.com/tx/3Y9CLmte817AyU6iBusvjj6tVccj1HRQxapAC86RBXfftzFokGYzVW6Rqk9Xz8LkRB9YRFoCVnEAPxmfRER42Rv8?cluster=devnet) | mainnet fork, 4 SOL refused at the cap |
| G5 leverage | needs fills | leverage replay, 97 refused (`notes/g5-replay.txt`) |
| G6 price band | [5% off the oracle refused](https://explorer.solana.com/tx/5LZdbdiNxGVD5rBQVQznjvZxDN1EgkqBoxX1kfK6x4QAKpQ7HjUtZW3NSJdJtE5TVNnzWiuniZxjGAC6gMyB4ceW?cluster=devnet) | tests |
| G7 owner only (limits, pause, agent) | the agent's MCP tools cannot change a limit | tests |
| G8 no withdraw | [agent's withdraw refused](https://explorer.solana.com/tx/MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3?cluster=devnet) | the program has no withdraw instruction |
| G9 exits always allowed (inside the band) | needs a position | tests (`notes/RED.md`, round 8) and a planted bug (`notes/planted-bug-summary.txt`) |
| G10 daily loss | needs fills | runaway replay, 20 refused (`notes/runaway-replay.txt`) |

`notes/planted-bug-summary.txt`: 75 bugs planted on purpose (each check broken or removed), 74 caught by the tests. The
one missed removes a backup check after the Velocity call that the checks before it make unreachable. Five internal
review rounds and their fixes are in `audits/`.

## Limits, plainly

- Devnet and local forks only; nothing runs on Solana mainnet.
- Velocity's devnet oracle is weeks old, so public devnet orders rest without filling; fills are shown on local forks.
- The guard wraps `place_perp_order` and `cancel_order`, not `place_and_take` (a missing feature, not a bypass).
- Leverage can drift with price after an order is placed (2.17x against a 2.0x cap in the leverage replay).
