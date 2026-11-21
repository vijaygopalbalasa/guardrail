#!/usr/bin/env node
// The G10 keeper: just after 00:00 UTC by the chain's clock it calls the guard's checkpoint for each owner, so each UTC day is marked at
// midnight equity (yesterday's losses stay on yesterday) and no caller can choose a lower baseline. The guard owner
// names the keeper with set_keeper (the quickstart uses the owner's own key). Run it from cron or keep it running:
//   node scripts/keeper.mjs --keypair <keeper.json> --owners <owner1,owner2> [--rpc URL] [--at-midnight | --now]
//   --now          checkpoint once right away (after the first hour of the day this uses the max rule, no midnight mark)
//   --at-midnight  wait for the chain's next 00:00 UTC, checkpoint (retrying until the day is marked), repeat daily
//   --tries N      tries per guard, 30 s apart (default 60)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const require = createRequire(new URL("../client/package.json", import.meta.url));
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { GuardrailClient } = await import("../client/dist/index.js");

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const kp = arg("--keypair"), owners = (arg("--owners") ?? "").split(",").filter(Boolean);
if (!kp || !owners.length || (!process.argv.includes("--now") && !process.argv.includes("--at-midnight"))) {
  console.error("usage: node scripts/keeper.mjs --keypair <keeper.json> --owners <a,b> [--rpc URL] (--now | --at-midnight)");
  process.exit(2);
}
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kp.replace(/^~(?=\/)/, homedir()), "utf8"))));
const client = new GuardrailClient(new Connection(arg("--rpc") ?? "https://api.devnet.solana.com", "confirmed"));

const conn = client.connection;
/** The chain's clock; getBlockTime can return null, which is retried, never read as 0. */
async function chainTime() {
  for (let k = 0; k < 20; k++) {
    try {
      const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
      if (typeof t === "number" && t > 0) return t;
    } catch { /* retried */ }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error("no block time from the RPC after 20 tries");
}
const chainDay = (t) => Math.floor(t / 86_400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TRIES = Number(arg("--tries") ?? 60); // one try every 30 s: up to the first 30 min of the UTC day

/** Checkpoints one owner's guard until its loss_day is the chain's day (or the tries run out), logging each try. */
async function mark(o) {
  for (let k = 1; k <= MAX_TRIES; k++) {
    const t = await chainTime();
    const at = new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
    try {
      const before = await client.getGuard(new PublicKey(o));
      const preempted = Number(before.dailyLoss?.day) === chainDay(t);
      const r = await client.checkpoint(keeper, new PublicKey(o));
      const g = await client.getGuard(new PublicKey(o));
      const ok = Number(g.dailyLoss?.day) === chainDay(t);
      const note = preempted ? " (pre-empted: the day's baseline was already set by an earlier call; not a midnight mark)" : ok ? " (day marked)" : " (not this day yet)";
      console.log(`${at} UTC (chain) try ${k}: checkpoint ${o} day ${g.dailyLoss?.day} baseline ${g.dailyLoss?.baselineEquity} tx ${r.signature}${note}`);
      if (ok) return true;
    } catch (e) {
      console.error(`${at} UTC (chain) try ${k}: checkpoint ${o} failed: ${e.message}`);
    }
    await sleep(30_000);
  }
  console.error(`ALERT: ${o} not marked after ${MAX_TRIES} tries; G10 carries the previous day's high until a mark or the owner's reset`);
  return false;
}

/** Every owner in parallel, each with its own time limit, so one slow guard never pushes another past the first hour. */
const PER_OWNER_MS = Number(arg("--owner-timeout-min") ?? 55) * 60_000;
async function round() {
  await Promise.all(owners.map((o) => Promise.race([
    mark(o),
    new Promise((r) => setTimeout(() => { console.error(`ALERT: ${o} timed out after ${PER_OWNER_MS / 60_000} min`); r(false); }, PER_OWNER_MS)),
  ])));
}

if (process.argv.includes("--now")) await round();
else {
  for (;;) {
    const t = await chainTime();
    const wait = 86_400 - (t % 86_400) + 5; // 5 s after the next 00:00 UTC by the chain's clock
    console.log(`chain time ${new Date(t * 1000).toISOString()}; next checkpoint in ${Math.round(wait / 60)} min`);
    await sleep(Math.max(1, wait - 60) * 1000);
    while (chainDay(await chainTime()) === chainDay(t)) await sleep(5_000); // wait for the chain to cross midnight
    await round();
  }
}
