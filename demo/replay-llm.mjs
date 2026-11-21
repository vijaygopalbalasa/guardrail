#!/usr/bin/env node
// Zero cost, no key, no SOL, no install: prints the recorded language-model agent's run on devnet, turn by turn: its
// own words, the order it asked for, the guard's on-chain verdict and the devnet transaction that proves it.
//   node demo/replay-llm.mjs
import { readFileSync } from "node:fs";

const dir = new URL("../dashboard/", import.meta.url);
const feed = JSON.parse(readFileSync(new URL("agent-feed.json", dir), "utf8"));
const snap = JSON.parse(readFileSync(new URL("snapshot.json", dir), "utf8"));
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const wrap = (t, w = 100, pad = "    ") => t.replace(/\s+/g, " ").match(new RegExp(`.{1,${w}}(\\s|$)`, "g")).map((l) => pad + l.trim()).join("\n");

// The guard's decisions, oldest first, matched to the turns where the agent placed an order.
const decisions = [...(snap.decisions ?? [])].sort((a, b) => Number(a.slot) - Number(b.slot));
let next = 0;
console.log(`${feed.label}\nModel: ${feed.model}. Guard ${feed.guard} on Solana devnet.\n`);
for (const t of feed.turns) {
  const reason = String(t.reason ?? "").replace(/^Reason:\s*/i, "").replace(/\*\*|`/g, "");
  console.log(`turn ${t.turn}:`);
  console.log(wrap(reason || "(no reason given)"));
  if (t.tool === "guardrail_place_order") {
    const a = t.args ?? {};
    const d = decisions[next++];
    const verdict = t.accepted ? "ACCEPTED on chain, sent to Velocity" : `REFUSED by ${t.rule} on chain; nothing reached Velocity`;
    console.log(`    -> asks to ${a.side === "short" ? "sell" : "buy"} ${a.size} SOL at $${a.price}: ${verdict}`);
    if (d) console.log(`       ${tx(d.signature)}`);
  } else if (t.tool === "guardrail_status") {
    console.log("    -> reads its limits and open orders");
  } else {
    console.log("    -> places nothing");
  }
}
const refused = Object.entries(snap.guard?.refused ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k} ${n}`).join(", ");
console.log(`\nOn chain now: ${snap.guard?.acceptedCount} accepted, refused ${refused || "none"} (read ${new Date(Number(snap.takenAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC).`);
console.log("Live view: https://guardrail-perps.vercel.app");
