// Owner side, run once on a local validator: a Velocity account with test dUSDT, a guard with the demo limits, and a
// fresh agent key. The agent never sees the owner's key.
import { Connection, Keypair } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GuardrailClient, toBase, ORDER_TYPE_BITS } from "@guardrail/client";
import { key, fund, setupVelocityAccount } from "../client/test/velocity-setup.mjs";

export const DEMO_LIMITS = {
  maxOrderBase: toBase(4), // G1: 4 SOL per order
  markets: [{ marketIndex: 0, maxExposureBase: toBase(6) }], // G2 allowlist + G4: 6 SOL worst case on SOL-PERP
  allowedOrderTypes: ORDER_TYPE_BITS.limit | ORDER_TYPE_BITS.oracle, // G2
  dailyNotionalCap: 1_200_000_000n, // G3: 1,200 dUSDT a day
  maxLeverageBps: 20_000, // G5: 2x
  priceBandBps: 200, // G6: 2% of the oracle
  maxOracleStalenessSlots: 1_000_000n,
  exitMaxStalenessSlots: 2_000_000n,
};

/**
 * Devnet: Velocity's devnet oracle is weeks old, so the order staleness limit is set very loose there (it is a
 * property of devnet, stated in the receipts), and the accounts are funded with small amounts of real devnet SOL.
 */
export const DEVNET = process.env.DEMO_NETWORK === "devnet";
const LIMITS = DEVNET ? { ...DEMO_LIMITS, maxOracleStalenessSlots: 100_000_000n, exitMaxStalenessSlots: 100_000_000n } : DEMO_LIMITS;

export async function setupDemo(rpc = "http://127.0.0.1:8999") {
  const conn = new Connection(rpc, "confirmed");
  const dev = key("dev");
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  await fund(conn, dev, owner.publicKey, DEVNET ? 90_000_000 : 5_000_000_000);
  await fund(conn, dev, agent.publicKey, DEVNET ? 20_000_000 : 1_000_000_000);
  await setupVelocityAccount(conn, owner, 1_000);
  const { guard, signature: initSig } = await new GuardrailClient(conn).initGuard(owner, agent.publicKey, LIMITS);
  const dir = fileURLToPath(new URL("../out/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const agentPath = `${dir}demo-agent-${agent.publicKey.toBase58().slice(0, 8)}.json`;
  writeFileSync(agentPath, JSON.stringify([...agent.secretKey]), { mode: 0o600 });
  return { rpc, owner: owner.publicKey.toBase58(), guard: guard.toBase58(), agentPath, initSig };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const d = await setupDemo(process.env.RPC_URL);
  writeFileSync(fileURLToPath(new URL("../out/demo.json", import.meta.url)), JSON.stringify(d, null, 2));
  console.log(JSON.stringify(d, null, 2));
}
