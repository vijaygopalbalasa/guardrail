#!/usr/bin/env node
// Talk to your guard the way an AI agent does: start the MCP server (mcp/server.mjs) with your agent key, read the guard
// through guardrail_status, then ask for orders the way an agent would. Each step says what the guard should answer; the
// run ends with a count and exits 1 if any answer differs.
// Public devnet orders rest and never fill (devnet's oracle is weeks old), so this shows the rules that need no fill:
// G1 order size, G6 price band, G2 order type, G4 worst-case exposure (resting orders count), and cancels (always
// allowed). It cancels what it placed, so you can run it again; more than twice in one UTC day and the G3 daily notional
// cap starts answering first. G5 leverage and G10 daily loss need fills: they bind in the replays on Velocity's real
// program (notes/g5-replay.txt, notes/runaway-replay.txt); G9 exits are in the tests (notes/RED.md). The agent has no
// tool that withdraws or changes a limit; its own key fails at both on chain:
// node demo/bypass-attempt.mjs
//   node demo/try-mcp.mjs                 uses out/quickstart.json, written by node demo/quickstart.mjs
//   GUARDRAIL_RPC_URL=... GUARDRAIL_AGENT_KEYPAIR=... GUARDRAIL_OWNER=... node demo/try-mcp.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { GuardrailClient } from "@guardrail/client";
import { fileURLToPath } from "node:url";
import { matches, verdictOf } from "./verdict.mjs";

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

const mcp = new Client({ name: "guardrail-try", version: "0.2.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))], env: { ...process.env, ...env } }));
const pause = () => new Promise((r) => setTimeout(r, 1500)); // public devnet RPC rate-limits bursts
const call = async (name, args) => { await pause(); return (await mcp.callTool({ name, arguments: args })).content[0].text; };
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}${env.GUARDRAIL_RPC_URL.includes("devnet") ? "?cluster=devnet" : ""}`;
const show = (label, text) => {
  const [first, ...rest] = text.split("\n");
  let sig = null;
  try { sig = JSON.parse(rest.join("\n")).signature || null; } catch { /* no verdict body */ }
  console.log(`${label}\n  ${first}${sig ? `\n  ${explorer(sig)}` : ""}`);
};
const results = [];
const expectAnswer = (text, expected) => {
  const ok = matches(text, expected);
  if (!ok) console.log(`  MISMATCH: expected ${expected === "ACCEPTED" || expected === "CANCELLED" ? expected : `REFUSED by ${expected}`}, got ${verdictOf(text)}`);
  results.push(ok);
  return ok;
};
let placed = 0;
const order = async (label, expected, args) => {
  const text = await call("guardrail_place_order", { side: "long", order_type: "limit", ...args });
  show(label, text);
  if (verdictOf(text) === "ACCEPTED") placed += 1;
  expectAnswer(text, expected);
};

try {
  console.log(`tools: ${(await mcp.listTools()).tools.map((t) => t.name).join(", ")} (none can withdraw or change a limit)`);
  const st = JSON.parse(await call("guardrail_status", {}));
  const L = st.limits_plain;
  const oracle = st.oracle ? Number(st.oracle.price_usd) : null;
  if (!oracle) throw new Error("could not read the SOL-PERP oracle price from guardrail_status");
  const price = Math.floor(oracle * 0.995 * 100) / 100; // inside the band
  const sol = L.markets.find((m) => m.market_index === 0);
  console.log(`guard: ${L.max_order_sol} SOL per order, ${sol ? `${sol.max_exposure_sol} SOL worst case on SOL-PERP` : "SOL-PERP not allowed"}, band ${L.price_band_pct}% of the oracle ($${oracle}), ${L.daily_notional_usd} dUSDT of orders a day, ${L.max_leverage_x}x`);

  const big = Math.max(L.max_order_sol * 2.5, L.max_order_sol + 1);
  await order(`1) buy ${big} SOL at $${price} (over the ${L.max_order_sol} SOL per-order limit)`, "G1", { size: big, price });
  const small = Math.min(1, L.max_order_sol);
  await order(`2) buy ${small} SOL at $${price} (inside every limit)`, "ACCEPTED", { size: small, price });
  const off = L.price_band_pct * 2.5;
  const far = Math.floor(oracle * (1 - off / 100) * 100) / 100;
  await order(`3) buy ${small} SOL at $${far} (${off}% below the oracle, outside the ${L.price_band_pct}% band)`, "G6", { size: small, price: far });
  if (Number(st.limits.allowedOrderTypes) & 1) {
    console.log("4) skipped: this guard allows market orders, so there is no order type to refuse");
  } else {
    await order(`4) a market order for ${small} SOL (this guard allows limit and oracle orders only)`, "G2", { size: small, price, order_type: "market" });
  }

  // G4 counts the position plus every resting order on that side, so orders that never fill still use up the cap.
  const now = JSON.parse(await call("guardrail_status", {}));
  const pos = now.positions.find((p) => p.market_index === 0);
  const worst = pos ? (Number(pos.base) + Number(pos.open_bids)) / 1e9 : 0;
  const fill = sol ? Math.min(L.max_order_sol, Math.floor((sol.max_exposure_sol - worst - 0.5) * 100) / 100) : 0;
  const more = sol ? Math.round((sol.max_exposure_sol - (worst + fill) + 0.5) * 100) / 100 : 0; // ends 0.5 SOL over the cap
  const today = Number(now.today_notional) / 1e6;
  if (!sol || fill < 0.1) {
    console.log(`5) skipped: the worst case on SOL-PERP is already ${worst} SOL, too close to the cap to show it`);
  } else if (today + (fill + more) * price > L.daily_notional_usd * 0.95) {
    console.log(`5) skipped: ${today.toFixed(0)} of today's ${L.daily_notional_usd} dUSDT are used (G3); run it again after 00:00 UTC`);
  } else {
    await order(`5a) buy ${fill} SOL at $${price} (worst case on SOL-PERP ${worst} -> ${(worst + fill).toFixed(2)} of ${sol.max_exposure_sol} SOL)`, "ACCEPTED", { size: fill, price });
    await order(`5b) buy ${more} SOL more (worst case would be ${(worst + fill + more).toFixed(2)} SOL, over the ${sol.max_exposure_sol} SOL cap; resting orders count)`, "G4", { size: more, price });
  }

  for (let i = 1; i <= placed; i++) {
    const text = await call("guardrail_cancel_order", {});
    show(`6) cancel an order this run placed (${i} of ${placed}; cancels are always allowed)`, text);
    expectAnswer(text, "CANCELLED");
  }

  const guard = new GuardrailClient(new Connection(env.GUARDRAIL_RPC_URL, "confirmed")).guardFor(new PublicKey(env.GUARDRAIL_OWNER)).guard.toBase58();
  console.log("");
  console.log("not shown here: G5 leverage and G10 daily loss need fills, and devnet orders never fill; they bind in notes/g5-replay.txt and notes/runaway-replay.txt (Velocity's real program); G9 exits are in the tests, notes/RED.md");
  console.log("the agent has no tool that withdraws or changes a limit; its own key fails at both on chain:  node demo/bypass-attempt.mjs");
  console.log(`dashboard: https://guardrail-perps.vercel.app/?rpc=${env.GUARDRAIL_RPC_URL}&guard=${guard}`);
  console.log(`${results.filter(Boolean).length} of ${results.length} answers as expected`);
  if (results.some((ok) => !ok)) process.exitCode = 1;
} finally {
  await mcp.close();
}
