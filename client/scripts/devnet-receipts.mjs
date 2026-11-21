// Builds notes/devnet-receipts.md from what is on devnet: the deploy, init_guard, and every guard transaction with
// its decoded verdict (accepted, or refused by which rule). Read-only.
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEvents, RULE_NAMES, GUARD_ERRORS } from "../dist/index.js";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(f) {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i > 8) throw e; await sleep(2000 * (i + 1)); }
  }
}
const tx = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const addr = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const [deploySig, ...setups] = process.argv.slice(2);
const lines = ["# Devnet receipts", "", "Guardrail's guard program on Solana devnet, with the fixed code (audit findings F1 to F4, then the R5 review: order lifetime and placed order ids).", "Velocity's devnet oracle is weeks old, so orders rest on Velocity devnet and do not fill; the demo guards use a loose", "staleness limit for that reason. Fills at moving prices are shown on a local surfpool fork (see the README).", ""];
lines.push(`- Program: [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](${addr("BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy")}) (sha256 of the deployed bytes in notes/devnet-guard-so.sha256)`);
lines.push(`- Deploy: [${deploySig.slice(0, 16)}...](${tx(deploySig)})`, "");
for (const f of setups) {
  const d = JSON.parse(readFileSync(f, "utf8"));
  lines.push(`## Guard ${d.guard} (${f.includes("calm") ? "calm agent" : f.includes("llm") ? "language-model agent, before the R5 upgrade" : f.includes("r6") ? "runaway agent, G10 set to 50 dUSDT a day" : f.includes("r5") ? "runaway agent, after the R5 upgrade, before G10" : "runaway agent"})`, "");
  lines.push(`- Guard account: [${d.guard}](${addr(d.guard)}); owner ${d.owner}`);
  lines.push(`- init_guard + delegate: [${d.initSig.slice(0, 16)}...](${tx(d.initSig)})`);
  const sigs = (await retry(() => conn.getSignaturesForAddress(new PublicKey(d.guard), { limit: 100 }))).reverse();
  const seen = new Set();
  for (const s of sigs) {
    if (s.err) continue;
    await sleep(1200);
    const t = await retry(() => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    const logs = t?.meta?.logMessages ?? [];
    const ev = decodeEvents(logs).find((e) => e.guard.toBase58() === d.guard);
    let label;
    if (ev) label = ev.accepted ? (ev.rule === 9 ? "accepted exit" : "accepted order") : `refused by ${RULE_NAMES[ev.rule]} (${GUARD_ERRORS[ev.reason]})`;
    else if (logs.some((l) => l.includes("guard: cancel"))) label = "cancel of a guard-placed order";
    else continue;
    if (seen.has(label)) continue;
    seen.add(label);
    lines.push(`- ${label}: [${s.signature.slice(0, 16)}...](${tx(s.signature)})`);
  }
  lines.push("");
}
writeFileSync(new URL("../../notes/devnet-receipts.md", import.meta.url), lines.join("\n"));
console.log(lines.join("\n"));
