#!/usr/bin/env node
// The agent tries to go around the guard on PUBLIC devnet. Using its own key, it calls Velocity directly (not through
// Guardrail): (a) place a perp order on the guarded account, (b) withdraw the account's dUSDT to itself, (c) make
// itself the account's delegate. Each transaction is sent with preflight skipped, so the refusal lands on chain with a
// signature anyone can open. Costs the agent three transaction fees (15,000 lamports); the token account it tries to
// create as the withdraw destination is rolled back with the failed withdraw.
//   node demo/bypass-attempt.mjs [--agent out/demo-agent-XXXX.json] [--owner <owner pubkey>]
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GuardrailClient, discriminator, encodeOrderParams, toBase, VELOCITY_PROGRAM_ID, velocityStateAddress, velocityUserAddress, spotMarketAddress,
} from "@guardrail/client";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Default: the language-model agent's guard on devnet (guard 9NJpRGSq..., owner FkQfmTpR...).
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(arg("--agent", `${ROOT}out/demo-agent-4Cxm3yCr.json`), "utf8"))));
const owner = new PublicKey(arg("--owner", "FkQfmTpReWXHHCoAc7vUmesKBDMSAwmx1GobETVeUMeS"));
const conn = new Connection(RPC, "confirmed");
const client = new GuardrailClient(conn);
const user = velocityUserAddress(owner);
const { guard } = client.guardFor(owner);
const P = (s) => new PublicKey(s);
const TOKEN = P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = P("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MINT = P("GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6");
const USDT_ORACLE = P("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");
const pda = (prog, ...s) => PublicKey.findProgramAddressSync(s, prog)[0];
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const vix = (keys, data) => new TransactionInstruction({ programId: VELOCITY_PROGRAM_ID, keys, data });
const short = (k) => `${k.toBase58().slice(0, 4)}...${k.toBase58().slice(-4)}`;

const cluster = RPC.includes("devnet") ? "?cluster=devnet" : RPC.includes("mainnet") ? "" : null;
const link = (sig) => (cluster === null ? sig : `https://explorer.solana.com/tx/${sig}${cluster}`);

/** Sends with preflight skipped and returns the landed transaction's error and logs. */
async function attempt(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(agent);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 40; i++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return { sig, err: t.meta.err, logs: t.meta.logMessages ?? [] };
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`transaction ${sig} did not land`);
}
const anchorError = (logs) => logs.map((l) => /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*)$/.exec(l)).find(Boolean);
const PLAIN = {
  ConstraintRaw: "Velocity takes orders on this account only from its owner or its delegate, and the delegate is the guard",
  ConstraintHasOne: "the account's authority is the owner's key, not the agent's",
  ConstraintSeeds: "the account's address is derived from the owner's key, so the agent's key cannot name it",
};

const uinfo = await conn.getAccountInfo(user, "confirmed");
if (!uinfo) throw new Error(`no Velocity account ${user.toBase58()}`);
const delegate = new PublicKey(uinfo.data.subarray(40, 72));
console.log(`guarded Velocity account ${short(user)} (owner ${short(owner)}); its delegate is the guard ${short(delegate)}${delegate.equals(guard) ? "" : " (NOT the guard!)"}`);
console.log(`agent ${short(agent.publicKey)} calls Velocity directly, skipping Guardrail:\n`);

const state = velocityStateAddress();
const stateInfo = await conn.getAccountInfo(state, "confirmed");
const velocitySigner = new PublicKey(stateInfo.data.subarray(488, 520));
const stats = pda(VELOCITY_PROGRAM_ID, Buffer.from("user_stats"), owner.toBuffer());
const agentAta = pda(ATA, agent.publicKey.toBuffer(), TOKEN.toBuffer(), MINT.toBuffer());
const pricing = await client.remainingAccounts(user, 0);

const tries = [
  {
    name: "(a) place a 20 SOL perp order on the owner's account",
    ixs: [vix([r(state), w(user), r(agent.publicKey, true), ...pricing], Buffer.concat([discriminator("global", "place_perp_order"), encodeOrderParams({ side: "long", size: toBase(20), orderType: "oracle", oracleOffset: 0n })]))],
  },
  {
    name: "(b) withdraw 100 dUSDT from the owner's account to itself",
    ixs: [
      // Its own dUSDT token account, the destination (idempotent create).
      new TransactionInstruction({ programId: ATA, keys: [w(agent.publicKey, true), w(agentAta), r(agent.publicKey), r(MINT), r(SystemProgram.programId), r(TOKEN)], data: Buffer.from([1]) }),
      vix([r(state), w(user), w(stats), r(agent.publicKey, true), w(pda(VELOCITY_PROGRAM_ID, Buffer.from("spot_market_vault"), u16(0))), r(velocitySigner), w(agentAta), r(TOKEN), r(USDT_ORACLE), w(spotMarketAddress(0))],
        Buffer.concat([discriminator("global", "withdraw"), u16(0), u64(100_000_000), Buffer.from([0])])),
    ],
  },
  {
    name: "(c) make itself the delegate instead of the guard",
    ixs: [vix([w(user), r(agent.publicKey, true)], Buffer.concat([discriminator("global", "update_user_delegate"), u16(0), agent.publicKey.toBuffer()]))],
  },
];

const results = [];
for (const t of tries) {
  const res = await attempt(t.ixs);
  const e = anchorError(res.logs);
  const line = res.logs.find((l) => l.includes("Error Code:")) ?? res.logs.find((l) => /failed|error/i.test(l)) ?? JSON.stringify(res.err);
  console.log(`${t.name}`);
  if (!res.err) {
    console.log(`   NOT REFUSED (this would be a bug): ${link(res.sig)}`);
  } else {
    console.log(`   REFUSED by Velocity: ${e ? `${e[1]} (${e[2]}): ${PLAIN[e[1]] ?? e[3]}` : JSON.stringify(res.err)}`);
    console.log(`   failed transaction on chain: ${link(res.sig)}`);
  }
  console.log("");
  results.push({ name: t.name, signature: res.sig, refused: !!res.err, error: res.err, log: line });
}
const after = await conn.getAccountInfo(user, "confirmed");
console.log(`after: delegate still ${short(new PublicKey(after.data.subarray(40, 72)))} (the guard), deposits unchanged: ${after.data.readBigUInt64LE(4392) === uinfo.data.readBigUInt64LE(4392)}, withdrawals unchanged: ${after.data.readBigUInt64LE(4400) === uinfo.data.readBigUInt64LE(4400)}`);
console.log(`the agent's only way to trade is through Guardrail; it has no way to withdraw.`);
if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
if (results.some((x) => !x.refused)) process.exit(1);
