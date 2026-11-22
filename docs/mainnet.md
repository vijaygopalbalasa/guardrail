# Mainnet readiness

Guardrail runs on devnet today. It is not deployed on mainnet, and no mainnet keys exist for it. This page is the plan
for when the owner decides to deploy.

## What is already checked against mainnet

- Velocity's mainnet program (a different build from devnet: 5.25 MB vs 6.05 MB) runs the whole LiteSVM suite, 117 of
  117 tests, with byte-identical replay output (`notes/mainnet-binary-check.txt`).
- The accounts the guard reads have the same sizes and offsets on mainnet as on devnet: State, Spot 0, Perp 0 and three
  live User accounts.
- The program address BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy is free on mainnet, so the client, MCP server and
  dashboard work there without changes.

## Cost

From `scripts/deploy-mainnet.sh` (dry run, Nov 22 2026, read from mainnet):

| Item | SOL | Comes back? |
|---|---|---|
| Program data, 358,000-byte binary plus 26,045 bytes of upgrade headroom (as on devnet) | 1.952 | Yes, when the program is closed (`solana program close`) |
| Without headroom (no room for a larger upgrade) | 1.820 | Yes, as above |
| Deploy buffer, held only while the deploy runs | 1.819 | Yes, when the deploy finishes |
| On-chain IDL (optional; lets the explorer name instructions) | 0.050 | Yes, if the IDL account is closed |
| Fees for the write transactions, plus any priority fee | about 0.01 to 0.02 | No |
| Each user's Guard account (paid by that owner) | 0.0064 | Yes, with `close_guard` |

So the payer needs about 3.9 SOL on hand during the deploy and ends about 1.85 to 2.0 SOL down, almost all of it rent
that closing the program returns.

## Steps

1. `scripts/deploy-mainnet.sh`: a dry run. It checks that the build is byte-identical to the audited devnet deploy,
   that the address is free on mainnet, reads the rent from mainnet and prints the exact commands. It signs nothing.
2. The owner creates a mainnet keypair outside this repository and funds it with about 3.9 SOL.
3. The owner picks an upgrade-authority plan:
   - `multisig:<PUBKEY>`: hand the upgrade authority to a multisig (for example a Squads vault) right after the
     deploy. Recommended: upgrades need more than one key.
   - `final`: make the program immutable. Safest against a stolen key, but no fixes are possible afterwards and
     Velocity is upgradeable, so a Velocity change could break an immutable guard for good.
   - `keep`: the deploy key stays the authority, only for a short review window.
4. `scripts/deploy-mainnet.sh --keypair <mainnet.json> --authority-plan <plan> --yes`: deploys with
   `--max-len` set for headroom, publishes the IDL, applies the authority plan and shows the program. The script
   refuses the devnet and demo keys in this repo, a missing plan, a payer under the needed balance, or an address
   that is already taken.
5. Compare the deployed bytes with the build, as `scripts/verify-devnet-program.sh` does for devnet.

## What changes on mainnet

- **Oracle staleness is tight.** Devnet's oracle is weeks old, so the demo guards there accept a 100,000,000-slot
  oracle age. On mainnet the SOL-PERP oracle is a live Pyth Lazer feed (oracle source 12); a guard should set the
  order staleness to tens of slots (for example 25 slots, about 10 s) and the exit staleness a little higher (for
  example 150 slots), so exits on a briefly stale oracle still pass on the owner-favourable side.
- **Real collateral.** Velocity's mainnet spot market 0 is USDT (mint Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB, 6
  decimals), not the devnet faucet's dUSDT. Owners deposit real USDT on Velocity themselves; there is no faucet.
- **The setup page and the quickstart stay devnet-only** until they are changed on purpose: `setup.html` sends only to
  devnet or a local validator, and the quickstart uses Velocity's devnet faucet. The dashboard can already read a
  mainnet guard (`?rpc=https://api.mainnet-beta.solana.com&guard=<address>`).
- **The keeper needs a server.** Each guard with a daily loss cap needs its UTC-midnight mark. On mainnet that is a
  keeper key on an always-on machine (`scripts/keeper.mjs --at-midnight`), named with `set_keeper`, not a laptop.
- **Limits are real money.** The presets are devnet starting points; owners should size order, exposure and daily loss
  limits to the account.

## Risks

- **No professional audit.** Five internal review rounds and 74 of 75 planted bugs caught are not an audit. Mainnet use
  with real funds should wait for one, or start with small accounts.
- **Velocity is upgradeable.** The guard depends on Velocity's account layouts, instructions and delegate rules. A
  Velocity upgrade can change them; the mainnet binary check must be rerun after any Velocity upgrade, and the guard
  should be paused if a check fails.
- **Upgrade key.** Whoever holds the guard's upgrade authority can change what every guard enforces. Hence the
  multisig plan.
- **What the guard does not do** (README): it does not close positions, does not bind the owner, and caps are checked
  when an order is placed, so leverage can drift with the price afterwards.
- **Program address key.** `keys/guard-program.json` is the address keypair used for the devnet deploy. It is needed
  only at the first deploy and gives no control afterwards (the upgrade authority does), but it lives on a development
  machine. A fresh address means changing `declare_id!`, the client and the dashboard, and rebuilding.
