// Test-only helpers: give an owner a Velocity account with test dUSDT from Velocity's own devnet faucet (cloned into
// the local validator). Not part of the client package.
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discriminator, VELOCITY_PROGRAM_ID, velocityUserAddress, velocityStateAddress, spotMarketAddress } from "../dist/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const key = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keys/${n}.json`, "utf8"))));
const P = (s) => new PublicKey(s);
const FAUCET = P("V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB");
const TOKEN = P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = P("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MINT = P("GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6");
const USDT_ORACLE = P("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const pda = (prog, ...s) => PublicKey.findProgramAddressSync(s, prog)[0];

export async function fund(conn, from, to, lamports) {
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })), [from]);
}

/** The instructions that create the owner's Velocity user (sub-account 0) and deposit `dusdt` test dollars. */
export function velocitySetupInstructions(o, { needStats = true, needUser = true, dusdt }) {
  const user = velocityUserAddress(o);
  const stats = pda(VELOCITY_PROGRAM_ID, Buffer.from("user_stats"), o.toBuffer());
  const state = velocityStateAddress();
  const vix = (keys, data) => new TransactionInstruction({ programId: VELOCITY_PROGRAM_ID, keys, data });
  const name = Buffer.alloc(32); name.write("guardrail");
  const ata = pda(ATA, o.toBuffer(), TOKEN.toBuffer(), MINT.toBuffer());
  const ixs = [];
  if (needStats) ixs.push(vix([w(stats), w(state), r(o), w(o, true), r(SYSVAR_RENT_PUBKEY), r(SystemProgram.programId)], discriminator("global", "initialize_user_stats")));
  if (needUser) ixs.push(vix([w(user), w(stats), w(state), r(o), w(o, true), r(SYSVAR_RENT_PUBKEY), r(SystemProgram.programId)], Buffer.concat([discriminator("global", "initialize_user"), u16(0), name])));
  ixs.push(new TransactionInstruction({ programId: ATA, keys: [w(o, true), w(ata), r(o), r(MINT), r(SystemProgram.programId), r(TOKEN)], data: Buffer.from([1]) }));
  ixs.push(new TransactionInstruction({
    programId: FAUCET,
    keys: [r(pda(FAUCET, Buffer.from("faucet_config"), MINT.toBuffer())), w(MINT), w(ata), r(pda(FAUCET, Buffer.from("mint_authority"), MINT.toBuffer())), r(TOKEN)],
    data: Buffer.concat([discriminator("global", "mint_to_user"), u64(dusdt * 1_000_000)]),
  }));
  ixs.push(vix([r(state), w(user), w(stats), r(o, true), w(pda(VELOCITY_PROGRAM_ID, Buffer.from("spot_market_vault"), u16(0))), w(ata), r(TOKEN), r(USDT_ORACLE), w(spotMarketAddress(0))],
    Buffer.concat([discriminator("global", "deposit"), u16(0), u64(dusdt * 1_000_000), Buffer.from([0])])));
  return ixs;
}

/** Creates the owner's Velocity user (sub-account 0) and deposits `dusdt` test dollars. */
export async function setupVelocityAccount(conn, owner, dusdt) {
  const o = owner.publicKey;
  const user = velocityUserAddress(o);
  const stats = pda(VELOCITY_PROGRAM_ID, Buffer.from("user_stats"), o.toBuffer());
  const tx = new Transaction().add(...velocitySetupInstructions(o, { needStats: !(await conn.getAccountInfo(stats)), needUser: !(await conn.getAccountInfo(user)), dusdt }));
  await sendAndConfirmTransaction(conn, tx, [owner], { commitment: "confirmed" });
  return user;
}

/** Open orders read straight from the Velocity User account. */
export async function openOrders(conn, owner) {
  const d = (await conn.getAccountInfo(velocityUserAddress(owner), "confirmed")).data;
  const out = [];
  for (let i = 0; i < 32; i++) {
    const o = 1064 + i * 104;
    if (d[o + 86] === 1) out.push({ orderId: d.readUInt32LE(o + 80), price: d.readBigUInt64LE(o + 8), size: d.readBigUInt64LE(o + 16) });
  }
  return out;
}
