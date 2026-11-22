#!/usr/bin/env node
// The scripted runaway agent against a FRESH guard on public devnet, with the demo limits (G1 4 SOL per order, G4 6 SOL
// worst-case exposure, G6 2% band, G10 50 dUSDT a day). It trades only through guardrail-mcp. Velocity's devnet oracle
// is stale, so accepted orders rest without filling; every refusal is a devnet transaction anyone can open.
// Costs about 0.11 devnet SOL from keys/dev.json (owner and agent funding, rent) plus a fee per order.
//   node demo/devnet-runaway.mjs        -> out/devnet-runaway.json and a log in out/
process.env.DEMO_NETWORK = "devnet";
process.env.DEMO_PACE_MS ??= "1500"; // the public devnet RPC rate-limits
const { writeFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { setupDemo } = await import("./setup.mjs");
const { runAgent } = await import("./agent.mjs");

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const demo = await setupDemo(RPC);
console.log(`fresh devnet guard ${demo.guard} (owner ${demo.owner})`);
const lines = [];
const summary = await runAgent({ mode: "runaway", demo, log: (l) => { lines.push(l); console.log(l); } });
const out = { ...demo, summary, ranAt: new Date().toISOString() };
writeFileSync(fileURLToPath(new URL("../out/devnet-runaway.json", import.meta.url)), JSON.stringify(out, null, 2));
writeFileSync(fileURLToPath(new URL(`../out/devnet-runaway-${demo.guard.slice(0, 8)}.log`, import.meta.url)), `${lines.join("\n")}\n`);
console.log(`dashboard: https://guardrail-perps.vercel.app/?rpc=${RPC}&guard=${demo.guard}`);
