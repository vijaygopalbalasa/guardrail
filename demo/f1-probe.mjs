#!/usr/bin/env node
// Audit F1 on a live RPC (surfpool fork of devnet, scripts/surfpool.sh start). A partner rests an ask 7% above the
// oracle; the agent sends an Oracle BUY with no offset (no worst price). The fixed guard refuses it, so nothing
// reaches Velocity; the same order with an in-band offset is accepted. LOCAL FORK, NOT LIVE TRADING.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { GuardrailClient, toBase, toPrice, ORDER_TYPE_BITS, velocityUserAddress } from "@guardrail/client";
import { key, fund, setupVelocityAccount } from "../client/test/velocity-setup.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8997";
const conn = new Connection(RPC, "confirmed");
const client = new GuardrailClient(conn);
const dev = key("dev");
const owner = Keypair.generate(), agent = Keypair.generate();
await fund(conn, dev, owner.publicKey, 2_000_000_000);
await fund(conn, dev, agent.publicKey, 500_000_000);
await setupVelocityAccount(conn, owner, 10_000);
await client.initGuard(owner, agent.publicKey, {
  maxOrderBase: toBase(4), markets: [{ marketIndex: 0, maxExposureBase: toBase(10) }],
  allowedOrderTypes: ORDER_TYPE_BITS.limit | ORDER_TYPE_BITS.oracle, dailyNotionalCap: 1_000_000_000_000n,
  maxLeverageBps: 50_000, priceBandBps: 100, maxOracleStalenessSlots: 100_000_000n, exitMaxStalenessSlots: 100_000_000n,
});
const orders = async () => {
  const d = (await conn.getAccountInfo(velocityUserAddress(owner.publicKey), "confirmed")).data;
  return [...Array(32).keys()].map((i) => 1064 + i * 104).filter((o) => d[o + 86] === 1).length;
};
const attack = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), orderType: "oracle", auction: { duration: 10, start: 0n, end: 0n } } });
console.log(`ATTACK (Oracle BUY, no offset, no worst price): ${attack.accepted ? "ACCEPTED" : `REFUSED by ${attack.ruleName} (${attack.reasonName})`}; orders on Velocity: ${await orders()}; tx ${attack.signature}`);
const twin = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), orderType: "oracle", oracleOffset: toPrice(0.5), auction: { duration: 10, start: 0n, end: 0n } } });
console.log(`TWIN (Oracle BUY, offset +0.50, inside the 1% band): ${twin.accepted ? "ACCEPTED" : `REFUSED by ${twin.ruleName}`}; orders on Velocity: ${await orders()}; tx ${twin.signature}`);
