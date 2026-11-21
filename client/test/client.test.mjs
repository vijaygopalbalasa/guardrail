// @guardrail/client against a local validator running Velocity's devnet binary and cloned devnet state, plus the
// guard program (scripts/local-validator.sh start). Prices are the cloned devnet oracle's (about $91.39).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { GuardrailClient, GuardrailError, toBase, toPrice, ORDER_TYPE_BITS } from "../dist/index.js";
import { key, fund, setupVelocityAccount, openOrders } from "./velocity-setup.mjs";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8999", "confirmed");
const client = new GuardrailClient(conn);
const dev = key("dev");

const limits = {
  maxOrderBase: toBase(2),
  markets: [{ marketIndex: 0, maxExposureBase: toBase(10) }],
  allowedOrderTypes: ORDER_TYPE_BITS.limit | ORDER_TYPE_BITS.oracle,
  dailyNotionalCap: 1_000_000_000n,
  maxLeverageBps: 30_000,
  priceBandBps: 300,
  maxOracleStalenessSlots: 1_000_000n,
  exitMaxStalenessSlots: 2_000_000n,
};

test("client: accepted order, refused order with its verdict, counters, cancel, revoked agent", async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  await fund(conn, dev, owner.publicKey, 5_000_000_000);
  await fund(conn, dev, agent.publicKey, 1_000_000_000);
  await setupVelocityAccount(conn, owner, 1_000);
  const { guard } = await client.initGuard(owner, agent.publicKey, limits);
  assert.ok(guard instanceof PublicKey);

  const ok = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), price: toPrice(90), postOnly: true } });
  assert.equal(ok.accepted, true);
  assert.equal(ok.ruleName, "accepted");
  assert.equal((await openOrders(conn, owner.publicKey)).length, 1, "order rests on Velocity");

  const no = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(3), price: toPrice(90), postOnly: true } });
  assert.deepEqual({ accepted: no.accepted, rule: no.rule, ruleName: no.ruleName, value: no.value, cap: no.cap, reasonName: no.reasonName },
    { accepted: false, rule: 1, ruleName: "G1 order size", value: toBase(3), cap: toBase(2), reasonName: "OrderTooLarge" });
  assert.equal((await openOrders(conn, owner.publicKey)).length, 1, "the refused order never reached Velocity");

  const band = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), price: toPrice(80), postOnly: true } });
  assert.equal(band.ruleName, "G6 price band");

  const g = await client.getGuard(owner.publicKey);
  assert.equal(g.acceptedCount, 1n);
  assert.equal(g.refused.G1, 1n);
  assert.equal(g.refused.G6, 1n);
  assert.equal(g.lastRefusal.rule, 6);
  assert.equal(g.agent.toBase58(), agent.publicKey.toBase58());
  assert.equal(g.dailyLoss.max, 0n, "the daily loss brake starts off");
  assert.equal(await client.wouldOnlyReduce(owner.publicKey, { side: "short", size: toBase(1) }), false, "no position: a sell is not an exit");
  await client.setDailyLoss(owner, 50_000_000n);
  assert.equal((await client.getGuard(owner.publicKey)).dailyLoss.max, 50_000_000n, "the owner sets G10");

  await client.cancelOrder({ agent, owner: owner.publicKey });
  assert.equal((await openOrders(conn, owner.publicKey)).length, 0, "cancelled");

  await client.setAgent(owner, PublicKey.default);
  await assert.rejects(
    client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(1), price: toPrice(90), postOnly: true } }),
    (e) => e instanceof GuardrailError && e.codeName === "AgentRevoked",
  );
});
