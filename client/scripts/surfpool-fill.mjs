// Time-boxed check: on a surfpool fork of devnet, can we move Velocity's oracle with the surfnet_setAccount
// cheatcode and get real fills at moving prices through the guard? Local only.
//   RPC_URL=http://127.0.0.1:8997 node client/scripts/surfpool-fill.mjs
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { GuardrailClient, toBase, toPrice, ORDER_TYPE_BITS, discriminator, velocityUserAddress, velocityStateAddress, spotMarketAddress, perpMarketAddress, VELOCITY_PROGRAM_ID, encodeOrderParams } from "../dist/index.js";
import { key, fund, setupVelocityAccount } from "../test/velocity-setup.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8997";
const conn = new Connection(RPC, { commitment: "confirmed", wsEndpoint: process.env.WS_URL ?? "ws://127.0.0.1:8996" });
const client = new GuardrailClient(conn);
const SOL_ORACLE = new PublicKey("2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV");
const USDT_ORACLE = new PublicKey("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");
const ORACLE_DISC = Buffer.from("9f07a1f922517985", "hex");

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Rewrites a PythLazerOracle account with the cheatcode: price in $ x 1e6, posted in the current slot. */
async function setOracle(address, price1e6) {
  const slot = await conn.getSlot("confirmed");
  const d = Buffer.alloc(48);
  ORACLE_DISC.copy(d, 0);
  d.writeBigInt64LE(BigInt(price1e6) * 100n, 8);
  d.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 16);
  d.writeBigUInt64LE(BigInt(slot), 24);
  d.writeInt32LE(-8, 32);
  d.writeBigUInt64LE(1_000_000n, 40);
  await rpc("surfnet_setAccount", [address.toBase58(), { data: d.toString("hex"), owner: VELOCITY_PROGRAM_ID.toBase58() }]);
  const back = (await conn.getAccountInfo(address, "confirmed")).data;
  return { slot, readBack: Number(back.readBigInt64LE(8)) / 1e8, postedSlot: Number(back.readBigUInt64LE(24)) };
}

const base = async (owner) => {
  const d = (await conn.getAccountInfo(velocityUserAddress(owner), "confirmed")).data;
  let b = 0n, q = 0n;
  for (let i = 0; i < 8; i++) { const o = 424 + i * 80; if (d.readUInt16LE(o + 76) === 0) { b += d.readBigInt64LE(o + 8); q += d.readBigInt64LE(o + 16); } }
  return { base: Number(b) / 1e9, quote: Number(q) / 1e6 };
};

const dev = key("dev");
const owner = Keypair.generate(), agent = Keypair.generate(), flow = Keypair.generate();
for (const k of [owner, agent, flow]) await fund(conn, dev, k.publicKey, 5_000_000_000);
await setupVelocityAccount(conn, owner, 1_000);
await setupVelocityAccount(conn, flow, 100_000);
const limits = { maxOrderBase: toBase(4), markets: [{ marketIndex: 0, maxExposureBase: toBase(10) }], allowedOrderTypes: ORDER_TYPE_BITS.limit, dailyNotionalCap: 1_000_000_000_000n, maxLeverageBps: 50_000, priceBandBps: 300, maxOracleStalenessSlots: 150n, exitMaxStalenessSlots: 1_000n };
await client.initGuard(owner, agent.publicKey, limits);
console.log("guard created on the surfpool fork");

let price = 91_390_000;
console.log("oracle write:", await setOracle(SOL_ORACLE, price), await setOracle(USDT_ORACLE, 1_000_000));
const bidPrice = BigInt(Math.floor(price * 0.999 / 10) * 10);
const v = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), price: bidPrice, postOnly: true } });
console.log("agent bid through the guard:", v.accepted ? "ACCEPTED" : `REFUSED ${v.ruleName}`);

// flow sells into the agent's bid (place_and_take with the owner's Velocity user as maker)
const fu = velocityUserAddress(flow.publicKey);
const fstats = PublicKey.findProgramAddressSync([Buffer.from("user_stats"), flow.publicKey.toBuffer()], VELOCITY_PROGRAM_ID)[0];
const ou = velocityUserAddress(owner.publicKey);
const ostats = PublicKey.findProgramAddressSync([Buffer.from("user_stats"), owner.publicKey.toBuffer()], VELOCITY_PROGRAM_ID)[0];
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
await setOracle(SOL_ORACLE, price);
await setOracle(USDT_ORACLE, 1_000_000);
const take = new TransactionInstruction({
  programId: VELOCITY_PROGRAM_ID,
  keys: [r(velocityStateAddress()), w(fu), w(fstats), { pubkey: flow.publicKey, isSigner: true, isWritable: false }, r(SOL_ORACLE), r(USDT_ORACLE), w(spotMarketAddress(0)), w(perpMarketAddress(0)), w(ou), w(ostats)],
  data: Buffer.concat([discriminator("global", "place_and_take_perp_order"), encodeOrderParams({ side: "short", size: toBase(1000), price: bidPrice }), Buffer.from([0])]),
});
try {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), take), [flow], { commitment: "confirmed" });
  console.log("flow sell landed:", sig.slice(0, 16));
} catch (e) {
  console.log("flow sell FAILED:", e.message.split("\n")[0]);
  for (const l of (e.logs ?? []).filter((x) => /Error|error|log: [A-Z]/.test(x)).slice(0, 8)) console.log("   ", l);
}
console.log("owner position after the fill:", await base(owner.publicKey));
for (const p of [89_560_000, 87_730_000]) {
  await setOracle(SOL_ORACLE, p);
  const pos = await base(owner.publicKey);
  console.log(`price $${p / 1e6}: position ${pos.base} SOL, uPnL ${(pos.base * p / 1e6 + pos.quote).toFixed(4)} dUSDT`);
}
