#!/usr/bin/env node
// Writes dashboard/snapshot.json: the dashboard's last decoded read of its default devnet guard, which the page paints
// first and then replaces with a live read. Also writes dashboard/fills-run.json from notes/surfpool-live.txt (the
// recorded run with real fills on a local fork of devnet). Run after a new agent run or a devnet upgrade.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDashboard } from "../dashboard/guard-view.js";

const root = new URL("../", import.meta.url);
const feed = JSON.parse(readFileSync(new URL("dashboard/agent-feed.json", root), "utf8"));
const snap = await loadDashboard(feed.rpc, feed.guard, 25, 500);
const json = JSON.stringify({ takenAt: Math.floor(Date.now() / 1000), rpc: feed.rpc, guardAddress: feed.guard, ...snap }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);
writeFileSync(new URL("dashboard/snapshot.json", root), json);
console.log(`dashboard/snapshot.json: guard ${feed.guard}, ${snap.decisions.length} decisions, slot ${snap.slot}`);

// The recorded fills run: one row per step (price, position, unrealized PnL, orders accepted and refused that step).
const log = readFileSync(new URL("notes/surfpool-live.txt", root), "utf8").split("\n");
const steps = [];
let acc = 0, ref = 0;
for (const l of log) {
  if (/^step \d+: guardrail_place_order/.test(l)) { if (l.includes("ACCEPTED")) acc++; else if (l.includes("REFUSED")) ref++; }
  const m = l.match(/^market: SOL \$([\d.]+), guarded position ([\d.]+) SOL, unrealized PnL (-?[\d.]+) dUSDT/);
  if (m) { steps.push({ price: Number(m[1]), position: Number(m[2]), upnl: Number(m[3]), accepted: acc, refused: ref }); acc = 0; ref = 0; }
}
const last = log.find((l) => l.startsWith("LOCAL FORK"));
const fm = last.match(/SOL \$([\d.]+) -> \$([\d.]+); guarded position ([\d.]+) SOL, unrealized PnL (-?[\d.]+) dUSDT on ([\d,]+) collateral; accepted (\d+), refused (\{.*?\})/);
const fills = {
  label: "Velocity's real program on a local copy of devnet; the SOL price moved by our script; real fills from a second account. Recorded Nov 21 2026. Not live trading.",
  agent: "The scripted runaway agent: it doubles its order every step and retries smaller when refused.",
  capSol: 6, collateral: 1000,
  start: Number(fm[1]), end: Number(fm[2]), position: Number(fm[3]), upnl: Number(fm[4]), accepted: Number(fm[6]), refused: JSON.parse(fm[7]),
  steps: [...steps, { price: Number(fm[2]), position: Number(fm[3]), upnl: Number(fm[4]), accepted: 0, refused: 0, final: true }],
};
writeFileSync(new URL("dashboard/fills-run.json", root), JSON.stringify(fills, null, 1));
console.log(`dashboard/fills-run.json: ${steps.length} steps, final ${fills.position} SOL, uPnL ${fills.upnl}`);
