// A moving local market for surfpool forks: the SOL oracle is rewritten with surfpool's surfnet_setAccount cheatcode,
// and a flow account sells into the agent's accepted bids so they fill. LOCAL FORK ONLY.
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { discriminator, velocityUserAddress, velocityStateAddress, spotMarketAddress, perpMarketAddress, VELOCITY_PROGRAM_ID, encodeOrderParams, toBase, toPrice } from "@guardrail/client";
import { key, fund, setupVelocityAccount } from "../client/test/velocity-setup.mjs";

export const SOL_ORACLE = new PublicKey("2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV");
export const USDT_ORACLE = new PublicKey("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");

export async function createMarket(conn, rpcUrl, owner) {
  const setOracle = async (address, usd) => {
    const slot = await conn.getSlot("confirmed");
    const d = Buffer.alloc(48);
    Buffer.from("9f07a1f922517985", "hex").copy(d, 0);
    d.writeBigInt64LE(BigInt(Math.round(usd * 1e8)), 8);
    d.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 16);
    d.writeBigUInt64LE(BigInt(slot), 24);
    d.writeInt32LE(-8, 32);
    d.writeBigUInt64LE(1_000_000n, 40);
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setAccount", params: [address.toBase58(), { data: d.toString("hex"), owner: VELOCITY_PROGRAM_ID.toBase58() }] }) });
    const j = await r.json();
    if (j.error) throw new Error(`surfnet_setAccount: ${JSON.stringify(j.error)} (is this a surfpool RPC?)`);
  };
  const flow = Keypair.generate();
  await fund(conn, key("dev"), flow.publicKey, 5_000_000_000);
  await setupVelocityAccount(conn, flow, 100_000);
  const pda = (seed, k) => PublicKey.findProgramAddressSync([Buffer.from(seed), k.toBuffer()], VELOCITY_PROGRAM_ID)[0];
  const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  let price = 91.39;
  return {
    get price() { return price; },
    async setPrice(usd) { price = usd; await setOracle(SOL_ORACLE, usd); await setOracle(USDT_ORACLE, 1); },
    /** The flow account sells into the agent's resting bid at `limit` (only long entries are filled in this demo). */
    async fillBid(size, limit) {
      await setOracle(SOL_ORACLE, price);
      const ix = new TransactionInstruction({
        programId: VELOCITY_PROGRAM_ID,
        keys: [r(velocityStateAddress()), w(velocityUserAddress(flow.publicKey)), w(pda("user_stats", flow.publicKey)), { pubkey: flow.publicKey, isSigner: true, isWritable: false },
          r(SOL_ORACLE), r(USDT_ORACLE), w(spotMarketAddress(0)), w(perpMarketAddress(0)), w(velocityUserAddress(owner)), w(pda("user_stats", owner))],
        data: Buffer.concat([discriminator("global", "place_and_take_perp_order"), encodeOrderParams({ side: "short", size: toBase(size + 50), price: toPrice(limit) }), Buffer.from([0])]),
      });
      await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix), [flow], { commitment: "confirmed" });
    },
  };
}
