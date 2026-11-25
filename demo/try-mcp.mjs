#!/usr/bin/env node
// Talk to your guard the way an AI agent does: start the MCP server (mcp/server.mjs) with your agent key, read the guard
// through guardrail_status, then place one order over the per-order limit (the guard refuses it on chain) and one inside
// every limit (the guard sends it to Velocity). Devnet orders rest without filling: devnet's oracle is weeks old.
//   node demo/try-mcp.mjs                 uses out/quickstart.json, written by node demo/quickstart.mjs
//   GUARDRAIL_RPC_URL=... GUARDRAIL_AGENT_KEYPAIR=... GUARDRAIL_OWNER=... node demo/try-mcp.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { GuardrailClient } from "@guardrail/client";
import { fileURLToPath } from "node:url";

const qsPath = fileURLToPath(new URL("../out/quickstart.json", import.meta.url));
const qs = existsSync(qsPath) ? JSON.parse(readFileSync(qsPath, "utf8")) : {};
const env = {
  GUARDRAIL_RPC_URL: process.env.GUARDRAIL_RPC_URL ?? qs.rpc ?? "https://api.devnet.solana.com",
  GUARDRAIL_AGENT_KEYPAIR: process.env.GUARDRAIL_AGENT_KEYPAIR ?? qs.agentPath,
  GUARDRAIL_OWNER: process.env.GUARDRAIL_OWNER ?? qs.owner,
};
if (!env.GUARDRAIL_AGENT_KEYPAIR || !env.GUARDRAIL_OWNER) {
  console.error("run node demo/quickstart.mjs --keypair <devnet wallet.json> first, or set GUARDRAIL_AGENT_KEYPAIR and GUARDRAIL_OWNER");
  process.exit(2);
}

const mcp = new Client({ name: "guardrail-try", version: "0.1.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))], env: { ...process.env, ...env } }));
const call = async (name, args) => (await mcp.callTool({ name, arguments: args })).content[0].text;
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}${env.GUARDRAIL_RPC_URL.includes("devnet") ? "?cluster=devnet" : ""}`;
const show = (label, text) => {
  const [first, ...rest] = text.split("\n");
  let sig = null;
  try { sig = JSON.parse(rest.join("\n")).signature ?? null; } catch { /* no verdict body */ }
  console.log(`${label}\n  ${first}${sig ? `\n  ${explorer(sig)}` : ""}`);
};

try {
  console.log(`tools: ${(await mcp.listTools()).tools.map((t) => t.name).join(", ")} (none can change a limit)`);
  const st = JSON.parse(await call("guardrail_status", {}));
  const limits = st.limits_plain;
  const price = st.oracle ? Math.floor(Number(st.oracle.price_usd) * 0.995 * 100) / 100 : null;
  if (!price) throw new Error("could not read the SOL-PERP oracle price from guardrail_status");
  console.log(`guard: ${limits.max_order_sol} SOL per order, ${limits.markets.map((m) => `${m.max_exposure_sol} SOL worst case on market ${m.market_index}`).join(", ")}, band ${limits.price_band_pct}% of the oracle ($${st.oracle.price_usd})`);
  const big = Math.max(limits.max_order_sol * 2.5, limits.max_order_sol + 1);
  show(`1) buy ${big} SOL at $${price} (over the ${limits.max_order_sol} SOL per-order limit)`, await call("guardrail_place_order", { side: "long", size: big, price, order_type: "limit" }));
  const small = Math.min(1, limits.max_order_sol);
  show(`2) buy ${small} SOL at $${price} (inside every limit)`, await call("guardrail_place_order", { side: "long", size: small, price, order_type: "limit" }));
  const guard = new GuardrailClient(new Connection(env.GUARDRAIL_RPC_URL, "confirmed")).guardFor(new PublicKey(env.GUARDRAIL_OWNER)).guard.toBase58();
  console.log(`dashboard: https://guardrail-perps.vercel.app/?rpc=${env.GUARDRAIL_RPC_URL}&guard=${guard}`);
} finally {
  await mcp.close();
}
