#!/usr/bin/env node
// The G10 keeper: just after 00:00 UTC it calls the guard's checkpoint for each owner, so each UTC day is marked at
// midnight equity (yesterday's losses stay on yesterday) and no caller can choose a lower baseline. The guard owner
// names the keeper with set_keeper (the quickstart uses the owner's own key). Run it from cron or keep it running:
//   node scripts/keeper.mjs --keypair <keeper.json> --owners <owner1,owner2> [--rpc URL] [--at-midnight | --now]
//   --now          checkpoint once right away (after the first hour of the day this uses the max rule, no midnight mark)
//   --at-midnight  wait for the next 00:00 UTC, checkpoint, then repeat every day
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

async function round() {
  const at = new Date().toISOString().slice(0, 19).replace("T", " ");
  for (const o of owners) {
    try {
      const r = await client.checkpoint(keeper, new PublicKey(o));
      const g = await client.getGuard(new PublicKey(o));
      console.log(`${at} UTC checkpoint ${o}: day ${g.dailyLoss?.day} baseline ${g.dailyLoss?.baselineEquity} tx ${r.signature}`);
    } catch (e) {
      console.error(`${at} UTC checkpoint ${o} failed: ${e.message}`);
    }
  }
}

if (process.argv.includes("--now")) await round();
else {
  for (;;) {
    const ms = 86_400_000 - (Date.now() % 86_400_000) + 5_000; // 5 s after the next 00:00 UTC
    console.log(`next checkpoint in ${Math.round(ms / 60_000)} min`);
    await new Promise((r) => setTimeout(r, ms));
    await round();
  }
}
