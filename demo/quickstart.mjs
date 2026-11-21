#!/usr/bin/env node
// Quickstart on Solana devnet with Node only (no Rust): your devnet wallet becomes the owner of a Velocity account
// funded with 1,000 test dUSDT from Velocity's devnet faucet, a guard with the demo limits becomes its delegate, and a
// fresh agent key is written to out/. It prints the live dashboard link for your guard.
//   node demo/quickstart.mjs --keypair ~/devnet-wallet.json      (the wallet needs about 0.2 devnet SOL)
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { GuardrailClient } from "@guardrail/client";
import { fund, setupVelocityAccount } from "../client/test/velocity-setup.mjs";
import { DEMO_LIMITS } from "./setup.mjs";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const path = arg("--keypair");
if (!path) {
  console.error("usage: node demo/quickstart.mjs --keypair <devnet wallet keypair file with about 0.2 devnet SOL>");
  process.exit(2);
}
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8"))));
const conn = new Connection(RPC, "confirmed");
const client = new GuardrailClient(conn);
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(4);
const start = await conn.getBalance(owner.publicKey);
console.log(`owner ${owner.publicKey.toBase58()} has ${sol(start)} SOL on ${new URL(RPC).hostname}`);
if (start < 0.15 * LAMPORTS_PER_SOL) {
  console.error("needs about 0.2 devnet SOL: https://faucet.solana.com");
  process.exit(1);
}

const { guard, velocityUser } = client.guardFor(owner.publicKey);
if (await conn.getAccountInfo(guard)) {
  console.log(`this wallet already has a guard: ${guard.toBase58()}`);
} else {
  console.log("1/3 Velocity account (sub-account 0) with 1,000 test dUSDT from Velocity's devnet faucet");
  await setupVelocityAccount(conn, owner, 1_000);
  const agent = Keypair.generate();
  console.log("2/3 a fresh agent key, funded with 0.02 SOL for fees");
  await fund(conn, owner, agent.publicKey, 0.02 * LAMPORTS_PER_SOL);
  const dir = fileURLToPath(new URL("../out/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const agentPath = `${dir}quickstart-agent-${agent.publicKey.toBase58().slice(0, 8)}.json`;
  writeFileSync(agentPath, JSON.stringify([...agent.secretKey]), { mode: 0o600 });
  console.log("3/3 the guard, with the demo limits, as the account's delegate; daily loss cap 50 dUSDT");
  // Velocity's devnet oracle is weeks old, so the staleness limits are loose on devnet (orders rest and do not fill).
  await client.initGuard(owner, agent.publicKey, { ...DEMO_LIMITS, maxOracleStalenessSlots: 100_000_000n, exitMaxStalenessSlots: 100_000_000n });
  await client.setKeeper(owner, owner.publicKey); // a G10 cap needs a keeper: your own key (run scripts/keeper.mjs)
  await client.setDailyLoss(owner, 50_000_000n);
  writeFileSync(`${dir}quickstart.json`, JSON.stringify({ rpc: RPC, owner: owner.publicKey.toBase58(), guard: guard.toBase58(), agentPath }, null, 2));
  console.log(`agent key: ${agentPath}`);
  console.log(`try the agent: GUARDRAIL_RPC_URL=${RPC} GUARDRAIL_AGENT_KEYPAIR=${agentPath} GUARDRAIL_OWNER=${owner.publicKey.toBase58()} node mcp/server.mjs (an MCP server with 3 tools)`);
}
const end = await conn.getBalance(owner.publicKey);
console.log(`velocity account ${velocityUser.toBase58()}`);
console.log(`guard ${guard.toBase58()}`);
console.log(`cost: ${sol(start - end)} SOL (rent for the accounts plus fees and the agent's 0.02 SOL)`);
console.log(`dashboard: https://guardrail-perps.vercel.app/?rpc=${RPC}&guard=${guard.toBase58()}`);
console.log(`keeper (marks each UTC day at midnight): node scripts/keeper.mjs --keypair ${path} --owners ${owner.publicKey.toBase58()} --at-midnight`);
