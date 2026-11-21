#!/usr/bin/env node
// Live fills at moving prices, on a local surfpool fork of devnet (scripts/surfpool.sh start). LOCAL FORK, NOT LIVE
// TRADING: the SOL oracle is moved with surfpool's surfnet_setAccount cheatcode, and a local flow account sells into
// every accepted bid, so the guarded runaway agent gets real Velocity fills and a real unrealized loss.
//   node demo/live.mjs
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { discriminator, velocityUserAddress, velocityStateAddress, spotMarketAddress, perpMarketAddress, VELOCITY_PROGRAM_ID, encodeOrderParams, toBase, toPrice } from "@guardrail/client";
import { key, fund, setupVelocityAccount } from "../client/test/velocity-setup.mjs";
import { setupDemo } from "./setup.mjs";
import { runAgent } from "./agent.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8997";
const conn = new Connection(RPC, "confirmed");
const SOL_ORACLE = new PublicKey("2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV");
const USDT_ORACLE = new PublicKey("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");

async function setOracle(address, usd) {
  const slot = await conn.getSlot("confirmed");
  const d = Buffer.alloc(48);
  Buffer.from("9f07a1f922517985", "hex").copy(d, 0);
  d.writeBigInt64LE(BigInt(Math.round(usd * 1e8)), 8);
  d.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 16);
  d.writeBigUInt64LE(BigInt(slot), 24);
  d.writeInt32LE(-8, 32);
  d.writeBigUInt64LE(1_000_000n, 40);
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setAccount", params: [address.toBase58(), { data: d.toString("hex"), owner: VELOCITY_PROGRAM_ID.toBase58() }] }) });
  const j = await r.json();
  if (j.error) throw new Error(`surfnet_setAccount: ${JSON.stringify(j.error)} (is this a surfpool RPC?)`);
}

const demo = await setupDemo(RPC);
const dev = key("dev");
const flow = Keypair.generate();
await fund(conn, dev, flow.publicKey, 5_000_000_000);
await setupVelocityAccount(conn, flow, 100_000);
const owner = new PublicKey(demo.owner);
const pda = (seed, k) => PublicKey.findProgramAddressSync([Buffer.from(seed), k.toBuffer()], VELOCITY_PROGRAM_ID)[0];
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

let price = 91.39;
const path = [];
async function account() {
  const d = (await conn.getAccountInfo(velocityUserAddress(owner), "confirmed")).data;
  let b = 0n, q = 0n;
  for (let i = 0; i < 8; i++) { const o = 424 + i * 80; if (d.readUInt16LE(o + 76) === 0) { b += d.readBigInt64LE(o + 8); q += d.readBigInt64LE(o + 16); } }
  return { position: Number(b) / 1e9, upnl: Number(b) / 1e9 * price + Number(q) / 1e6 };
}

const summary = await runAgent({
  mode: "runaway-live",
  demo,
  beforeStep: async (step) => {
    if (step > 0) { const a = await account(); path.push({ step: step - 1, price, ...a }); console.log(`market: SOL $${price.toFixed(2)}, guarded position ${a.position} SOL, unrealized PnL ${a.upnl.toFixed(2)} dUSDT`); }
    price = 91.39 * 0.99 ** step;
    await setOracle(SOL_ORACLE, price);
    await setOracle(USDT_ORACLE, 1);
    return price;
  },
  afterAccept: async (a) => {
    await setOracle(SOL_ORACLE, price);
    const ix = new TransactionInstruction({
      programId: VELOCITY_PROGRAM_ID,
      keys: [r(velocityStateAddress()), w(velocityUserAddress(flow.publicKey)), w(pda("user_stats", flow.publicKey)), { pubkey: flow.publicKey, isSigner: true, isWritable: false },
        r(SOL_ORACLE), r(USDT_ORACLE), w(spotMarketAddress(0)), w(perpMarketAddress(0)), w(velocityUserAddress(owner)), w(pda("user_stats", owner))],
      data: Buffer.concat([discriminator("global", "place_and_take_perp_order"), encodeOrderParams({ side: "short", size: toBase(a.size + 50), price: toPrice(a.price) }), Buffer.from([0])]),
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix), [flow], { commitment: "confirmed" });
  },
});
const a = await account();
console.log(`LOCAL FORK (surfpool), oracle moved by cheatcode: SOL $91.39 -> $${price.toFixed(2)}; guarded position ${a.position} SOL, unrealized PnL ${a.upnl.toFixed(2)} dUSDT on 1,000 collateral; accepted ${summary.accepted}, refused ${JSON.stringify(summary.refused)}; exposure ${summary.exposure} SOL vs cap ${summary.cap}`);
