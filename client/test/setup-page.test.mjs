// Offline: the owner onboarding page (dashboard/setup-tx.js, no dependencies) must build exactly the instructions and
// addresses that @guardrail/client and @solana/web3.js build, and a wire format web3.js reads back unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Message, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { GuardrailClient, guardAddress, velocityUserAddress, perpMarketAddress as clientPerp, spotMarketAddress, toBase } from "../dist/index.js";
import { velocitySetupInstructions } from "./velocity-setup.mjs";
import { DEMO_LIMITS } from "../../demo/setup.mjs";
import * as page from "../../dashboard/setup-tx.js";

const norm = (ix) => ({
  programId: ix.programId.toString(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toString(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString("hex"),
});

/** A client whose send records the instructions instead of sending them. */
function recordingClient(connection = {}) {
  const c = new GuardrailClient(connection);
  const seen = [];
  c.send = async (ixs) => { seen.push(...ixs); return { signature: "x", logs: [] }; };
  return { c, seen };
}

test("program addresses match web3.js for random owners", async () => {
  for (let i = 0; i < 8; i++) {
    const o = Keypair.generate().publicKey;
    const a = await page.addressesFor(o.toBase58());
    const user = velocityUserAddress(o);
    assert.equal(a.velocityUser, user.toBase58());
    assert.equal(a.guard, guardAddress(user).toBase58());
    assert.equal(a.spot0, spotMarketAddress(0).toBase58());
    assert.equal(a.perp0, clientPerp(0).toBase58());
    assert.equal(await page.perpMarketAddress(3), clientPerp(3).toBase58());
  }
});

test("the on-curve check agrees with web3.js", () => {
  for (let i = 0; i < 300; i++) {
    const b = i < 50 ? Keypair.generate().publicKey.toBytes() : crypto.getRandomValues(new Uint8Array(32));
    assert.equal(page.onCurve(b), PublicKey.isOnCurve(b), Buffer.from(b).toString("hex"));
  }
});

test("Velocity account and faucet deposit: same instructions as the Node helper", async () => {
  const o = Keypair.generate().publicKey;
  const a = await page.addressesFor(o.toBase58());
  for (const opts of [{ needStats: true, needUser: true, dusdt: 1000 }, { needStats: false, needUser: false, dusdt: 1000 }]) {
    assert.deepEqual(page.velocitySetupIxs(o.toBase58(), a, opts).map(norm), velocitySetupInstructions(o, opts).map(norm));
  }
});

test("guard setup: init_guard + delegate, keeper, daily loss and agent fees match the client", async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate().publicKey;
  const a = await page.addressesFor(owner.publicKey.toBase58());
  const limits = page.toLimits(page.PRESETS.cautious);
  const { c, seen } = recordingClient();
  await c.initGuard(owner, agent, limits);
  await c.setKeeper(owner, owner.publicKey);
  await c.setDailyLoss(owner, page.dailyLossUnits(page.PRESETS.cautious));
  const fees = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent, lamports: 20_000_000 });
  const mine = page.guardSetupIxs(owner.publicKey.toBase58(), a, { agent: agent.toBase58(), limits, dailyLoss: page.dailyLossUnits(page.PRESETS.cautious), agentLamports: 20_000_000 });
  assert.deepEqual(mine.map(norm), [...seen, fees].map(norm));
  // No cap: no set_daily_loss; no fee transfer when the owner brings a funded agent.
  const bare = page.guardSetupIxs(owner.publicKey.toBase58(), a, { agent: agent.toBase58(), limits, dailyLoss: 0n, agentLamports: 0 });
  assert.deepEqual(bare.map(norm), seen.slice(0, 3).map(norm));
});

test("checkpoint: same accounts as the client, for an account with positions on two markets", async () => {
  const owner = Keypair.generate().publicKey;
  const a = await page.addressesFor(owner.toBase58());
  const user = Buffer.alloc(4496);
  user.writeBigInt64LE(3_000_000_000n, 424 + 8); user.writeUInt16LE(0, 424 + 76); // SOL-PERP position
  user.writeBigInt64LE(1_000_000n, 504 + 40); user.writeUInt16LE(2, 504 + 76); // an open bid on market 2
  const oracleOf = new Map();
  const market = (oracle, at, len) => { const d = Buffer.alloc(len); oracle.toBuffer().copy(d, at); return d; };
  const solOracle = Keypair.generate().publicKey, usdtOracle = Keypair.generate().publicKey, m2Oracle = Keypair.generate().publicKey;
  oracleOf.set(spotMarketAddress(0).toBase58(), market(usdtOracle, 40, 1064));
  oracleOf.set(clientPerp(0).toBase58(), market(solOracle, 312, 1560));
  oracleOf.set(clientPerp(2).toBase58(), market(m2Oracle, 312, 1560));
  const conn = {
    getAccountInfo: async () => ({ data: user }),
    getMultipleAccountsInfo: async (keys) => keys.map((k) => ({ data: oracleOf.get(k.toBase58()) })),
  };
  const { c, seen } = recordingClient(conn);
  await c.checkpoint(Keypair.generate(), owner); // payer differs; compare everything after it
  const markets = page.activeMarkets(new Uint8Array(user));
  assert.deepEqual(markets, [0, 2]);
  const perps = await Promise.all(markets.map(async (m) => { const address = await page.perpMarketAddress(m); return { address, data: oracleOf.get(address) }; }));
  const ix = page.checkpointIx(owner.toBase58(), a, page.pricingAccounts(a.spot0, oracleOf.get(a.spot0), perps));
  const want = norm(seen[0]);
  const got = norm(ix);
  assert.equal(got.data, want.data);
  assert.deepEqual(got.keys.slice(1), want.keys.slice(1));
});

test("wire format: web3.js reads the page's transaction back to the same instructions and signer slots", async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate().publicKey.toBase58();
  const a = await page.addressesFor(owner.publicKey.toBase58());
  const blockhash = Keypair.generate().publicKey.toBase58();
  for (const ixs of [
    page.velocitySetupIxs(owner.publicKey.toBase58(), a, { needStats: true, needUser: true, dusdt: 1000 }),
    page.guardSetupIxs(owner.publicKey.toBase58(), a, { agent, limits: page.toLimits(page.PRESETS.balanced), dailyLoss: 50_000_000n, agentLamports: 20_000_000 }),
  ]) {
    const wire = page.unsignedTransaction(owner.publicKey.toBase58(), ixs, blockhash);
    const tx = Transaction.from(Buffer.from(wire));
    assert.equal(tx.signatures.length, 1);
    assert.equal(tx.feePayer.toBase58(), owner.publicKey.toBase58());
    assert.equal(tx.recentBlockhash, blockhash);
    // web3.js merges flags per account; compare to the page's own instructions with merged flags.
    const merged = new Map();
    for (const ix of ixs) for (const k of ix.keys) { const m = merged.get(k.pubkey) ?? { s: false, w: false }; m.s ||= k.isSigner; m.w ||= k.isWritable; merged.set(k.pubkey, m); }
    merged.set(owner.publicKey.toBase58(), { s: true, w: true });
    assert.deepEqual(tx.instructions.map(norm), ixs.map((ix) => ({
      programId: ix.programId,
      keys: ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: merged.get(k.pubkey).s, isWritable: merged.get(k.pubkey).w })),
      data: Buffer.from(ix.data).toString("hex"),
    })));
    // Signing the page's message bytes with the owner gives a transaction web3.js verifies.
    tx.sign(owner);
    assert.ok(tx.verifySignatures());
    assert.deepEqual(Buffer.from(Message.from(Buffer.from(wire.subarray(65))).serialize()), Buffer.from(wire.subarray(65)));
  }
});

test("presets: Balanced is the demo limit set; units convert exactly", () => {
  const b = page.toLimits(page.PRESETS.balanced);
  assert.deepEqual({ ...b, maxOracleStalenessSlots: 0n, exitMaxStalenessSlots: 0n, maxOrderLifetimeSecs: undefined },
    { ...DEMO_LIMITS, maxOracleStalenessSlots: 0n, exitMaxStalenessSlots: 0n, maxOrderLifetimeSecs: undefined });
  assert.equal(b.maxOracleStalenessSlots, 100_000_000n);
  assert.equal(page.dailyLossUnits(page.PRESETS.balanced), 50_000_000n);
  const odd = page.toLimits({ orderSol: 0.1, exposureSol: 1.3, dailyVolumeUsd: 0.7 + 0.1, leverage: 1.15, bandPct: 0.35, dailyLossUsd: 0 });
  assert.equal(odd.maxOrderBase, toBase(0.1));
  assert.equal(odd.markets[0].maxExposureBase, 1_300_000_000n);
  assert.equal(odd.dailyNotionalCap, 800_000n);
  assert.equal(odd.maxLeverageBps, 11_500);
  assert.equal(odd.priceBandBps, 35);
  assert.deepEqual(page.checkPlain(page.PRESETS.loose), []);
  assert.match(page.checkPlain({ ...page.PRESETS.loose, orderSol: 30 }).join(" "), /above the most SOL at risk/);
  assert.match(page.checkPlain({ ...page.PRESETS.loose, leverage: Number.NaN }).join(" "), /Leverage cap: enter a number/);
  assert.match(page.checkPlain({ ...page.PRESETS.loose, bandPct: 90 }).join(" "), /Price band: between/);
});

test("agent key made with WebCrypto loads as the same key in web3.js (the file the MCP server reads)", async () => {
  const k = await page.newAgentKey();
  assert.equal(k.secret.length, 64);
  assert.equal(Keypair.fromSecretKey(k.secret).publicKey.toBase58(), k.publicKey);
});

test("keys and RPCs: bad text is refused; only devnet or a local validator", () => {
  assert.equal(page.parseKey("not a key"), null);
  assert.equal(page.parseKey("0OIl" + "1".repeat(40)), null);
  assert.equal(page.parseKey(Keypair.generate().publicKey.toBase58()).length, 32);
  assert.equal(page.setupRpc(null), "https://api.devnet.solana.com");
  assert.equal(page.setupRpc("http://127.0.0.1:8999"), "http://127.0.0.1:8999");
  for (const bad of ["https://api.mainnet-beta.solana.com", "https://evil.example", "javascript:alert(1)", "https://u:p@api.devnet.solana.com", "https://api.devnet.solana.com:8443", "http://api.devnet.solana.com"]) {
    assert.equal(page.setupRpc(bad), null, bad);
  }
  const cfg = JSON.parse(page.mcpConfig({ rpc: "https://api.devnet.solana.com", owner: "O", agentFile: "agent-ab.json" }));
  assert.deepEqual(Object.keys(cfg.mcpServers.guardrail.env), ["GUARDRAIL_RPC_URL", "GUARDRAIL_AGENT_KEYPAIR", "GUARDRAIL_OWNER"]);
});
