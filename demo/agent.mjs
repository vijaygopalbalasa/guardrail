#!/usr/bin/env node
// A scripted trading agent that trades ONLY through guardrail-mcp over stdio, like any agent framework would.
//   node demo/agent.mjs calm|runaway        (after node demo/setup.mjs on a local validator)
// The strategy is one pluggable function, decide(state) -> action. A language model can replace it without
// touching anything else.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// Strategies. state = { mode, step, oraclePrice, lastVerdict, pending, history }. An action is
//   { type: "place", side, size, price } | { type: "cancel" } | { type: "next" } | { type: "stop" }
// ---------------------------------------------------------------------------------------------------------------

/** Calm: three small resting bids near the market, then stop. */
function calm(s) {
  if (s.step >= 3) return { type: "stop" };
  if (s.placedThisStep) return { type: "next" };
  return { type: "place", side: "long", size: 0.5, price: round(s.oraclePrice * (1 - 0.003 * (s.step + 1))) };
}

/**
 * Runaway (the planted bug): a losing long it keeps averaging down. Every step it bids lower and wants double the
 * last size. When an order is refused it halves the order and retries; when the exposure cap stops it, it cancels
 * its latest bid to make room and tries again (fighting the limit), up to a retry budget.
 */
function runaway(s) {
  if (s.step >= 8) return { type: "stop" };
  if (s.wanted === undefined) s.wanted = 0.5 * 2 ** s.step;
  if (s.chunk === undefined) s.chunk = s.wanted;
  if (s.tries >= 8 || s.wanted <= 0 || s.chunk < 0.25) return { type: "next" };
  const v = s.lastVerdict;
  if (v && !v.accepted && s.lastAction === "place") {
    if (v.rule === 4 && s.cancels < 2) return { type: "cancel" };
    s.chunk /= 2;
  }
  return { type: "place", side: "long", size: Math.min(s.chunk, s.wanted), price: round(s.oraclePrice - 0.4 - 0.3 * s.step) };
}

export const STRATEGIES = { calm, runaway };
const round = (p) => Math.round(p * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// The loop: MCP tool calls only.
// ---------------------------------------------------------------------------------------------------------------

const parse = (res) => {
  const t = res.content[0].text;
  const i = t.indexOf("\n");
  return { line: i < 0 ? t : t.slice(0, i), data: i < 0 ? null : JSON.parse(t.slice(i + 1)) };
};
const sol = (x) => Number(x) / 1e9;

/** The guard's verdict in plain words. */
export function plain(v) {
  if (!v) return "no verdict";
  if (v.accepted) return v.rule === 9 ? "ACCEPTED as an exit, sent to Velocity" : "ACCEPTED, sent to Velocity";
  const val = Number(v.value), cap = Number(v.cap);
  const why = {
    1: () => `${val / 1e9} SOL is over the ${cap / 1e9} SOL per-order limit`,
    2: () => `${v.reasonName} (not on the owner's allowlist)`,
    3: () => `today's notional would be ${(val / 1e6).toFixed(2)} dUSDT, over the ${(cap / 1e6).toFixed(0)} dUSDT daily cap`,
    4: () => `worst-case exposure would be ${val / 1e9} SOL, over the ${cap / 1e9} SOL cap`,
    5: () => `worst-case leverage would be ${(val / 1e4).toFixed(2)}x, over the ${(cap / 1e4).toFixed(2)}x cap`,
    6: () => (v.reason === 6028 ? "a stale-oracle exit priced against the owner" : `the price is ${(val / 100).toFixed(2)}% from the oracle, outside the ${(cap / 100).toFixed(2)}% band`),
    7: () => "the owner paused the guard",
  }[v.rule];
  return `REFUSED by ${v.ruleName}: ${why ? why() : v.reasonName}; nothing reached Velocity`;
}

export async function runAgent({ mode, demo, decide = STRATEGIES[mode], oraclePrice = 91.39, log = console.log }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))],
    env: { ...process.env, GUARDRAIL_RPC_URL: demo.rpc, GUARDRAIL_AGENT_KEYPAIR: demo.agentPath, GUARDRAIL_OWNER: demo.owner },
  });
  const mcp = new Client({ name: `demo-agent-${mode}`, version: "0.1.0" });
  await mcp.connect(transport);
  const summary = { mode, accepted: 0, refused: {}, cancels: 0, toolCalls: 0 };
  try {
    log(`agent (${mode}) connected to guardrail-mcp; tools: ${(await mcp.listTools()).tools.map((t) => t.name).join(", ")}`);
    let s = { mode, step: 0, oraclePrice, tries: 0, cancels: 0, placedThisStep: false };
    for (let guardRails = 0; guardRails < 200; guardRails++) {
      const a = decide(s);
      if (a.type === "stop") break;
      if (a.type === "next") {
        s = { mode, step: s.step + 1, oraclePrice, tries: 0, cancels: 0, placedThisStep: false };
        continue;
      }
      summary.toolCalls++;
      if (a.type === "cancel") {
        const r = parse(await mcp.callTool({ name: "guardrail_cancel_order", arguments: {} }));
        summary.cancels++;
        s.cancels++;
        s.lastAction = "cancel";
        log(`step ${s.step}: guardrail_cancel_order (make room under the cap) -> ${r.line.startsWith("CANCELLED") ? "cancelled the latest bid" : r.line}`);
        continue;
      }
      const r = parse(await mcp.callTool({ name: "guardrail_place_order", arguments: { side: a.side, size: a.size, price: a.price, post_only: true } }));
      const v = r.data;
      s.tries++;
      s.lastAction = "place";
      s.placedThisStep = true;
      s.lastVerdict = v;
      if (v?.accepted) {
        summary.accepted++;
        s.wanted = (s.wanted ?? a.size) - a.size;
      } else if (v) {
        summary.refused[v.ruleName] = (summary.refused[v.ruleName] ?? 0) + 1;
      }
      log(`step ${s.step}: guardrail_place_order ${a.side} ${a.size} SOL @ ${a.price} -> ${plain(v)}`);
    }
    const st = JSON.parse((await mcp.callTool({ name: "guardrail_status", arguments: {} })).content[0].text);
    const p = st.positions.find((x) => x.market_index === 0) ?? { base: "0", open_bids: "0", open_asks: "0" };
    const exposure = Math.max(Math.abs(sol(p.base) + sol(p.open_bids)), Math.abs(sol(p.base) + sol(p.open_asks)));
    const cap = sol(st.limits.markets.find((m) => m.marketIndex === 0)?.maxExposureBase ?? 0);
    Object.assign(summary, { exposure, cap, guardAccepted: Number(st.accepted), guardRefused: Object.fromEntries(Object.entries(st.refused).map(([k, n]) => [k, Number(n)])) });
    const refusals = Object.entries(summary.refused).map(([k, n]) => `${n} by ${k}`).join(", ") || "none";
    log(`summary: ${summary.accepted} accepted, refused ${refusals}; worst-case exposure ${exposure} SOL vs cap ${cap} SOL; the guard's on-chain counters: accepted ${st.accepted}, refused ${JSON.stringify(summary.guardRefused)}`);
  } finally {
    await mcp.close();
  }
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "runaway";
  if (!STRATEGIES[mode]) { console.error("usage: node demo/agent.mjs calm|runaway"); process.exit(2); }
  const demo = JSON.parse(readFileSync(fileURLToPath(new URL("../out/demo.json", import.meta.url)), "utf8"));
  await runAgent({ mode, demo });
}
