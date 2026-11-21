// Seeds a local validator (scripts/local-validator.sh start) with a guarded Velocity account and a short history of
// accepted and refused orders, then prints the dashboard URL. Local demo data, not live trading.
import { Connection, Keypair } from "@solana/web3.js";
import { GuardrailClient, toBase, toPrice, ORDER_TYPE_BITS } from "../dist/index.js";
import { key, fund, setupVelocityAccount } from "../test/velocity-setup.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8999";
const conn = new Connection(RPC, "confirmed");
const client = new GuardrailClient(conn);
const dev = key("dev");
const owner = Keypair.generate();
const agent = Keypair.generate();
await fund(conn, dev, owner.publicKey, 5_000_000_000);
await fund(conn, dev, agent.publicKey, 1_000_000_000);
await setupVelocityAccount(conn, owner, 1_000);
const limits = {
  maxOrderBase: toBase(4),
  markets: [{ marketIndex: 0, maxExposureBase: toBase(10) }],
  allowedOrderTypes: ORDER_TYPE_BITS.limit | ORDER_TYPE_BITS.oracle,
  dailyNotionalCap: 1_500_000_000n,
  maxLeverageBps: 20_000,
  priceBandBps: 200,
  maxOracleStalenessSlots: 1_000_000n,
  exitMaxStalenessSlots: 2_000_000n,
};
const { guard } = await client.initGuard(owner, agent.publicKey, limits);
const place = async (label, order) => {
  const v = await client.placeOrder({ agent, owner: owner.publicKey, order: { postOnly: true, ...order } });
  console.log(`${label}: ${v.accepted ? "ACCEPTED" : `REFUSED by ${v.ruleName} (${v.reasonName})`}`);
};
await place("buy 2 SOL @ 90.50", { side: "long", size: toBase(2), price: toPrice(90.5) });
await place("buy 8 SOL @ 90.50", { side: "long", size: toBase(8), price: toPrice(90.5) });
await place("buy 4 SOL @ 90.40", { side: "long", size: toBase(4), price: toPrice(90.4) });
await place("buy 4 SOL @ 90.30", { side: "long", size: toBase(4), price: toPrice(90.3) });
await place("buy 4 SOL @ 90.20", { side: "long", size: toBase(4), price: toPrice(90.2) });
await place("buy 2 SOL @ 80.00", { side: "long", size: toBase(2), price: toPrice(80) });
await place("market buy 1 SOL", { side: "long", size: toBase(1), price: toPrice(92), orderType: "market", postOnly: false });
await client.setPaused(owner, true);
await place("buy 1 SOL while paused", { side: "long", size: toBase(1), price: toPrice(90) });
await client.setPaused(owner, false);
console.log(`\nguard ${guard.toBase58()}\nowner ${owner.publicKey.toBase58()}\nhttp://127.0.0.1:8780/?guard=${guard.toBase58()}`);
