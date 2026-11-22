// Owner onboarding, pure parts: addresses, instruction bytes, the legacy transaction format, presets and plain-unit
// conversions. No dependencies; runs in the browser and in Node (client/test/setup-page.test.mjs checks every
// instruction against @guardrail/client and @solana/web3.js).
import { b58encode, GUARD_PROGRAM_ID, VELOCITY_PROGRAM_ID } from "./guard-view.js?v=30";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
/** Velocity's devnet faucet for test dUSDT, and the dUSDT mint and oracle. */
export const FAUCET_PROGRAM = "V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB";
export const DUSDT_MINT = "GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6";
export const DUSDT_ORACLE = "Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4";
export const DEFAULT_KEY = SYSTEM_PROGRAM;

/** sha256("global:<name>")[0..8], Anchor's instruction tags (checked against the client in the tests). */
const TAG = {
  initialize_user_stats: "fef34862fb82a8d5", initialize_user: "6f11b9fa3c7a26fe", mint_to_user: "4bc22c4d0a41e855",
  deposit: "f223c68952e1f2b6", init_guard: "506c44e6fd86279b", update_user_delegate: "8bcd8d8d71245ebb",
  set_keeper: "665e174e9ddef3d6", set_daily_loss: "dfda384aa0033223", checkpoint: "d5c813ccf08fb8fc",
};
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const tag = (name) => fromHex(TAG[name]);

// ---------- base58 keys ----------

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A 32-byte public key from base58, or null if the text is not one. */
export function parseKey(text) {
  const t = String(text ?? "").trim();
  if (!B58.test(t)) return null;
  let n = 0n;
  for (const c of t) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of t) { if (c === "1") out.unshift(0); else break; }
  return out.length === 32 ? Uint8Array.from(out) : null;
}
const key = (s) => { const k = parseKey(s); if (!k) throw new Error(`not a public key: ${s}`); return k; };

// ---------- program addresses ----------

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = mod(-121665n * pow(121666n, P - 2n));
/** True when the 32 bytes decode to a point on ed25519 (such an address has a private key, so it is no PDA). */
export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  const x2 = (u * pow(v, P - 2n)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}
const enc = new TextEncoder();
async function sha256(...parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}
/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export async function findPda(seeds, programId) {
  const prog = key(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256(...seeds, Uint8Array.of(bump), prog, enc.encode("ProgramDerivedAddress"));
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no program address");
}
const u16 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255);

export async function addressesFor(owner) {
  const o = key(owner);
  const velocityUser = await findPda([enc.encode("user"), o, u16(0)], VELOCITY_PROGRAM_ID);
  return {
    velocityUser,
    userStats: await findPda([enc.encode("user_stats"), o], VELOCITY_PROGRAM_ID),
    guard: await findPda([enc.encode("guard"), key(velocityUser)], GUARD_PROGRAM_ID),
    dusdtAccount: await findPda([o, key(TOKEN_PROGRAM), key(DUSDT_MINT)], ATA_PROGRAM),
    state: await findPda([enc.encode("velocity_state")], VELOCITY_PROGRAM_ID),
    spot0: await findPda([enc.encode("spot_market"), u16(0)], VELOCITY_PROGRAM_ID),
    perp0: await findPda([enc.encode("perp_market"), u16(0)], VELOCITY_PROGRAM_ID),
    spot0Vault: await findPda([enc.encode("spot_market_vault"), u16(0)], VELOCITY_PROGRAM_ID),
    faucetConfig: await findPda([enc.encode("faucet_config"), key(DUSDT_MINT)], FAUCET_PROGRAM),
    mintAuthority: await findPda([enc.encode("mint_authority"), key(DUSDT_MINT)], FAUCET_PROGRAM),
  };
}

// ---------- little-endian writer ----------

class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { return this.u8(v).u8(v >> 8); }
  u32(v) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 255); return this; }
  u64(v) { let x = BigInt.asUintN(64, BigInt(v)); for (let i = 0; i < 8; i++) { this.b.push(Number(x & 255n)); x >>= 8n; } return this; }
  bytes(a) { for (const x of a) this.b.push(x); return this; }
  done() { return Uint8Array.from(this.b); }
}
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

// ---------- limits ----------

export const ORDER_TYPES_LIMIT_AND_ORACLE = 2 | 16;
/** Velocity's devnet oracle is weeks old, so the staleness limits are this loose on devnet (stated on the page). */
export const DEVNET_STALENESS_SLOTS = 100_000_000n;

/** Plain units the owner types. Balanced is the demo set used across the README and the quickstart. */
export const PRESETS = {
  cautious: { orderSol: 1, exposureSol: 2, dailyVolumeUsd: 300, leverage: 1, bandPct: 1, dailyLossUsd: 20 },
  balanced: { orderSol: 4, exposureSol: 6, dailyVolumeUsd: 1200, leverage: 2, bandPct: 2, dailyLossUsd: 50 },
  loose: { orderSol: 10, exposureSol: 20, dailyVolumeUsd: 5000, leverage: 5, bandPct: 5, dailyLossUsd: 200 },
};
const BOUNDS = {
  orderSol: [0.001, 10_000, "Largest single order"], exposureSol: [0.001, 100_000, "Most SOL at risk"],
  dailyVolumeUsd: [1, 100_000_000, "Daily trading volume"], leverage: [0.1, 20, "Leverage cap"],
  bandPct: [0.05, 50, "Price band"], dailyLossUsd: [0, 100_000_000, "Daily loss brake"],
};
const scaled = (x, scale) => BigInt(Math.round(x * scale));

/** Checks the form values; returns a list of plain-language problems (empty when fine). */
export function checkPlain(p) {
  const out = [];
  for (const [k, [lo, hi, name]] of Object.entries(BOUNDS)) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${name}: enter a number.`);
    else if (v < lo || v > hi) out.push(`${name}: between ${lo} and ${hi}.`);
  }
  if (!out.length && p.orderSol > p.exposureSol) out.push("Largest single order is above the most SOL at risk, so every order of that size would be refused.");
  return out;
}

/** Plain units to the program's units: SOL 1e9, dUSDT 1e6, leverage and band in basis points. */
export function toLimits(p) {
  return {
    maxOrderBase: scaled(p.orderSol, 1e9),
    markets: [{ marketIndex: 0, maxExposureBase: scaled(p.exposureSol, 1e9) }],
    allowedOrderTypes: ORDER_TYPES_LIMIT_AND_ORACLE,
    dailyNotionalCap: scaled(p.dailyVolumeUsd, 1e6),
    maxLeverageBps: Math.round(p.leverage * 10_000),
    priceBandBps: Math.round(p.bandPct * 100),
    maxOracleStalenessSlots: DEVNET_STALENESS_SLOTS,
    exitMaxStalenessSlots: DEVNET_STALENESS_SLOTS,
    maxOrderLifetimeSecs: 0n,
  };
}
export const dailyLossUnits = (p) => scaled(p.dailyLossUsd, 1e6);

export function encodeLimits(l) {
  const w = new W().u64(l.maxOrderBase);
  for (let i = 0; i < 8; i++) {
    const m = l.markets[i] ?? { marketIndex: 0, maxExposureBase: 0n };
    w.u16(m.marketIndex).u64(m.maxExposureBase);
  }
  return w.u8(l.allowedOrderTypes).u64(l.dailyNotionalCap).u32(l.maxLeverageBps).u32(l.priceBandBps)
    .u64(l.maxOracleStalenessSlots).u64(l.exitMaxStalenessSlots).u64(l.maxOrderLifetimeSecs ?? 0n).done();
}

// ---------- instructions ----------

/**
 * The Velocity account (sub-account 0) with `dusdt` test dollars from Velocity's devnet faucet: user stats and user
 * when missing, the dUSDT token account (idempotent), the faucet mint and the deposit.
 */
export function velocitySetupIxs(owner, a, { needStats, needUser, dusdt }) {
  const ixs = [];
  if (needStats) ixs.push({ programId: VELOCITY_PROGRAM_ID, keys: [meta(a.userStats, false, true), meta(a.state, false, true), meta(owner, false, false), meta(owner, true, true), meta(RENT_SYSVAR, false, false), meta(SYSTEM_PROGRAM, false, false)], data: tag("initialize_user_stats") });
  if (needUser) {
    const name = new Uint8Array(32); name.set(enc.encode("guardrail"));
    ixs.push({ programId: VELOCITY_PROGRAM_ID, keys: [meta(a.velocityUser, false, true), meta(a.userStats, false, true), meta(a.state, false, true), meta(owner, false, false), meta(owner, true, true), meta(RENT_SYSVAR, false, false), meta(SYSTEM_PROGRAM, false, false)], data: new W().bytes(tag("initialize_user")).u16(0).bytes(name).done() });
  }
  if (dusdt > 0) {
    const amount = BigInt(dusdt) * 1_000_000n;
    ixs.push({ programId: ATA_PROGRAM, keys: [meta(owner, true, true), meta(a.dusdtAccount, false, true), meta(owner, false, false), meta(DUSDT_MINT, false, false), meta(SYSTEM_PROGRAM, false, false), meta(TOKEN_PROGRAM, false, false)], data: Uint8Array.of(1) });
    ixs.push({ programId: FAUCET_PROGRAM, keys: [meta(a.faucetConfig, false, false), meta(DUSDT_MINT, false, true), meta(a.dusdtAccount, false, true), meta(a.mintAuthority, false, false), meta(TOKEN_PROGRAM, false, false)], data: new W().bytes(tag("mint_to_user")).u64(amount).done() });
    ixs.push({ programId: VELOCITY_PROGRAM_ID, keys: [meta(a.state, false, false), meta(a.velocityUser, false, true), meta(a.userStats, false, true), meta(owner, true, false), meta(a.spot0Vault, false, true), meta(a.dusdtAccount, false, true), meta(TOKEN_PROGRAM, false, false), meta(DUSDT_ORACLE, false, false), meta(a.spot0, false, true)], data: new W().bytes(tag("deposit")).u16(0).u64(amount).u8(0).done() });
  }
  return ixs;
}

/**
 * The guard as the account's delegate, the owner as keeper, the daily loss cap, and fee money for the agent, in one
 * transaction. The keeper goes before the cap: the program refuses a cap without a keeper.
 */
export function guardSetupIxs(owner, a, { agent, limits, dailyLoss, agentLamports }) {
  const ownerIx = (name, args) => ({ programId: GUARD_PROGRAM_ID, keys: [meta(owner, true, false), meta(a.guard, false, true)], data: new W().bytes(tag(name)).bytes(args).done() });
  const ixs = [
    { programId: GUARD_PROGRAM_ID, keys: [meta(owner, true, true), meta(a.velocityUser, false, false), meta(a.guard, false, true), meta(SYSTEM_PROGRAM, false, false)], data: new W().bytes(tag("init_guard")).bytes(key(agent)).bytes(encodeLimits(limits)).done() },
    { programId: VELOCITY_PROGRAM_ID, keys: [meta(a.velocityUser, false, true), meta(owner, true, false)], data: new W().bytes(tag("update_user_delegate")).u16(0).bytes(key(a.guard)).done() },
    ownerIx("set_keeper", key(owner)),
  ];
  if (dailyLoss > 0n) ixs.push(ownerIx("set_daily_loss", new W().u64(dailyLoss).done()));
  if (agentLamports > 0) ixs.push({ programId: SYSTEM_PROGRAM, keys: [meta(owner, true, true), meta(agent, false, true)], data: new W().u32(2).u64(agentLamports).done() });
  return ixs;
}

/** Markets the guard prices for this user, as the client does: `market` plus every market with a position or order. */
export function activeMarkets(userU8, market = 0) {
  const out = [market];
  if (!userU8) return out;
  const v = new DataView(userU8.buffer, userU8.byteOffset, userU8.byteLength);
  for (let i = 0; i < 8; i++) {
    const o = 424 + i * 80;
    const active = [8, 16, 40, 48].some((f) => v.getBigInt64(o + f, true) !== 0n) || userU8[o + 78] !== 0;
    const idx = v.getUint16(o + 76, true);
    if (active && !out.includes(idx)) out.push(idx);
  }
  return out;
}
export const perpMarketAddress = (i) => findPda([enc.encode("perp_market"), u16(i)], VELOCITY_PROGRAM_ID);

/** The extra accounts a guard call needs: each market's oracle (spot 0 first, no repeats), spot 0, then the perps. */
export function pricingAccounts(spot0, spot0U8, perps) {
  const oracles = [];
  const add = (k) => { if (!oracles.includes(k)) oracles.push(k); };
  add(b58encode(spot0U8.subarray(40, 72)));
  for (const p of perps) add(b58encode(p.data.subarray(312, 344)));
  return [...oracles.map((k) => meta(k, false, false)), meta(spot0, false, true), ...perps.map((p) => meta(p.address, false, true))];
}

/** The owner's checkpoint: marks today's baseline for the daily loss brake at the equity now. */
export function checkpointIx(owner, a, remaining) {
  return { programId: GUARD_PROGRAM_ID, keys: [meta(owner, true, false), meta(a.guard, false, true), meta(a.velocityUser, false, false), ...remaining], data: tag("checkpoint") };
}

// ---------- legacy transactions ----------

function compactU16(n) { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }

/** A legacy message: fee payer first, then signers that write, signers that read, accounts that write, the rest. */
export function compileMessage(payer, ixs, recentBlockhash) {
  const m = new Map([[payer, { s: true, w: true }]]);
  const add = (k, s, w) => { const x = m.get(k) ?? { s: false, w: false }; x.s ||= s; x.w ||= w; m.set(k, x); };
  for (const ix of ixs) { for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable); add(ix.programId, false, false); }
  const rank = ([k, x]) => (k === payer ? 0 : x.s && x.w ? 1 : x.s ? 2 : x.w ? 3 : 4);
  const accounts = [...m].sort((p, q) => rank(p) - rank(q));
  const index = new Map(accounts.map(([k], i) => [k, i]));
  const signers = accounts.filter(([, x]) => x.s);
  const out = [signers.length, signers.filter(([, x]) => !x.w).length, accounts.filter(([, x]) => !x.s && !x.w).length];
  out.push(...compactU16(accounts.length));
  for (const [k] of accounts) out.push(...key(k));
  out.push(...key(recentBlockhash));
  out.push(...compactU16(ixs.length));
  for (const ix of ixs) {
    out.push(index.get(ix.programId), ...compactU16(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)));
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return { message: Uint8Array.from(out), signers: signers.map(([k]) => k) };
}

/** The wire transaction with empty signature slots, for a wallet to sign. Over 1,232 bytes is refused by the network. */
export function unsignedTransaction(payer, ixs, recentBlockhash) {
  const { message, signers } = compileMessage(payer, ixs, recentBlockhash);
  const tx = new Uint8Array([...compactU16(signers.length), ...new Uint8Array(64 * signers.length), ...message]);
  if (tx.length > 1232) throw new Error(`transaction is ${tx.length} bytes, over the 1,232 byte limit`);
  return tx;
}

/** The first signature of a wire transaction, in base58 (the transaction id). */
export function firstSignature(tx) { return b58encode(tx.subarray(1, 65)); }

// ---------- agent key and MCP config ----------

/** A new Ed25519 key made in this browser: the 64-byte secret (seed then public key) the MCP server reads. */
export async function newAgentKey() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(pkcs8.length - 32), 0);
  secret.set(pub, 32);
  return { publicKey: b58encode(pub), secret };
}

export function mcpConfig({ rpc, owner, agentFile }) {
  return JSON.stringify({
    mcpServers: {
      guardrail: {
        command: "node",
        args: ["/path/to/guardrail/mcp/server.mjs"],
        env: { GUARDRAIL_RPC_URL: rpc, GUARDRAIL_AGENT_KEYPAIR: `/path/to/${agentFile}`, GUARDRAIL_OWNER: owner },
      },
    },
  }, null, 2);
}

/** The RPCs this page may send to: Solana's public devnet, or a local validator for development. Never mainnet. */
export function setupRpc(param) {
  if (param === null || param === undefined || param === "") return "https://api.devnet.solana.com";
  let u;
  try { u = new URL(param); } catch { return null; }
  if (u.username || u.password) return null;
  const local = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.protocol === "http:";
  const devnet = u.protocol === "https:" && u.hostname === "api.devnet.solana.com" && !u.port;
  return local || devnet ? u.origin : null;
}
