// The fill step on a surfpool fork of mainnet. Velocity matches orders only when someone sends fill_perp_order, a
// permissionless crank that keeper bots run on mainnet; on a local fork nobody else runs it, so a fork-only filler key
// does. It chooses no price and no size: it names the agent's order and the best resting asks read from mainnet, and
// Velocity's own matching decides what fills (those makers or its AMM). LOCAL FORK ONLY.
import { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { discriminator, VELOCITY_PROGRAM_ID, velocityUserAddress, velocityStateAddress, spotMarketAddress, perpMarketAddress } from "@guardrail/client";

export const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
export const SOL_ORACLE = new PublicKey("2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV");
const pda = (...s) => PublicKey.findProgramAddressSync(s, VELOCITY_PROGRAM_ID)[0];
const statsOf = (authority) => pda(Buffer.from("user_stats"), authority.toBuffer());
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

export async function rpcCall(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** The SOL-PERP oracle as the fork sees it (streamed from mainnet): price in USD x 1e6 and the slot it was posted. */
export async function oracle(conn) {
  const d = (await conn.getAccountInfo(SOL_ORACLE, "confirmed")).data;
  const exp = d.readInt32LE(32), raw = d.readBigInt64LE(8);
  const price = exp + 6 >= 0 ? raw * 10n ** BigInt(exp + 6) : raw / 10n ** BigInt(-(exp + 6));
  return { price, postedSlot: d.readBigUInt64LE(24) };
}

/** Open orders of a Velocity User account (raw data). */
export function orders(d) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const o = 1064 + i * 104;
    if (d[o + 86] !== 1) continue;
    out.push({ orderId: d.readUInt32LE(o + 80), market: d.readUInt16LE(o + 84), marketType: d[o + 88], orderType: d[o + 87], dir: d[o + 91], reduceOnly: d[o + 92] === 1, postOnly: d[o + 93] === 1,
      price: d.readBigUInt64LE(o + 8), base: d.readBigUInt64LE(o + 16), filled: d.readBigUInt64LE(o + 24), offset: d.readBigInt64LE(o + 72), maxTs: d.readBigInt64LE(o + 64) });
  }
  return out;
}

/** Perp and spot markets a User account touches (positions or open orders). */
export function userMarkets(d) {
  const perps = new Set(), spots = new Set();
  for (let i = 0; i < 8; i++) { const o = 424 + i * 80; if ([8, 16, 40, 48].some((f) => d.readBigInt64LE(o + f) !== 0n) || d[o + 78] !== 0) perps.add(d.readUInt16LE(o + 76)); }
  for (let i = 0; i < 8; i++) { const o = 104 + i * 40; if (d.readBigUInt64LE(o) !== 0n || d[o + 35] !== 0) spots.add(d.readUInt16LE(o + 32)); }
  return { perps, spots };
}

/**
 * The best resting asks on a perp market at or under `maxPrice` (USD x 1e6), read from MAINNET with one
 * getProgramAccounts call (read only): resting limit sells that are not reduce-only and not expired, one per maker,
 * best price first. Oracle-offset asks are priced at `oraclePrice` plus their offset.
 * `fork`: a Map from maker User address to that maker's FORK copy (raw data). A maker this run already traded with is
 * read from its fork copy instead of mainnet, so an order that already filled on the fork is not shown or used again.
 */
export async function bestAsks(market, oraclePrice, maxPrice, limit = 2, { nowSec = Math.floor(Date.now() / 1000), fork = null } = {}) {
  const res = await rpcCall(MAINNET_RPC, "getProgramAccounts", [VELOCITY_PROGRAM_ID.toBase58(), { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 4496 }, { memcmp: { offset: 4472, bytes: "2" } }] }]);
  const asks = [];
  for (const a of res) {
    const d = fork?.get(a.pubkey) ?? Buffer.from(a.account.data[0], "base64");
    for (const o of orders(d)) {
      if (o.market !== market || o.marketType !== 1 || o.orderType !== 1 || o.dir !== 1 || o.reduceOnly) continue;
      if (o.maxTs !== 0n && o.maxTs < BigInt(nowSec + 3)) continue;
      const price = o.offset !== 0n ? BigInt(oraclePrice) + o.offset : o.price;
      if (price <= 0n || price > BigInt(maxPrice)) continue;
      asks.push({ user: new PublicKey(a.pubkey), authority: new PublicKey(d.subarray(8, 40)), orderId: o.orderId, price, size: o.base - o.filled, data: d });
    }
  }
  asks.sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0));
  const seen = new Set(), picked = [];
  for (const a of asks) { if (seen.has(a.user.toBase58())) continue; seen.add(a.user.toBase58()); picked.push(a); if (picked.length >= limit) break; }
  return picked;
}

// OrderActionRecord, the event Velocity logs for every fill (field order from Velocity's IDL; only the head is read).
const RECORD_DISC = createHash("sha256").update("event:OrderActionRecord").digest().subarray(0, 8);
const EXPLANATIONS = { 6: "AMM", 7: "AMM (JIT)", 8: "maker", 9: "maker (JIT)" };
export function decodeFillRecords(logs) {
  const out = [];
  for (const line of logs ?? []) {
    const m = /^Program (?:data|log): ([A-Za-z0-9+/=]{100,})$/.exec(line);
    if (!m) continue;
    const d = Buffer.from(m[1], "base64");
    if (d.length < 20 || !d.subarray(0, 8).equals(RECORD_DISC)) continue;
    let o = 8;
    const opt = (n, read) => { if (d[o++] === 0) return null; const v = read(o); o += n; return v; };
    const u64 = (p) => d.readBigUInt64LE(p), i64 = (p) => d.readBigInt64LE(p), u32 = (p) => d.readUInt32LE(p), pk = (p) => new PublicKey(d.subarray(p, p + 32)).toBase58(), u8 = (p) => d[p];
    const rec = { ts: i64(o) }; o += 8;
    rec.action = d[o++]; rec.explanation = d[o++]; rec.marketIndex = d.readUInt16LE(o); o += 2; rec.marketType = d[o++];
    rec.filler = opt(32, pk); rec.fillerReward = opt(8, u64); rec.fillRecordId = opt(8, u64);
    rec.baseFilled = opt(8, u64); rec.quoteFilled = opt(8, u64); rec.takerFee = opt(8, u64); rec.makerFee = opt(8, i64);
    rec.referrerReward = opt(4, u32); rec.quoteSurplus = opt(8, i64); rec.spotFee = opt(8, u64);
    rec.taker = opt(32, pk); rec.takerOrderId = opt(4, u32); rec.takerDir = opt(1, u8); rec.takerBase = opt(8, u64); rec.takerCumBase = opt(8, u64); rec.takerCumQuote = opt(8, u64);
    rec.maker = opt(32, pk); rec.makerOrderId = opt(4, u32); rec.makerDir = opt(1, u8); rec.makerBase = opt(8, u64); rec.makerCumBase = opt(8, u64); rec.makerCumQuote = opt(8, u64);
    rec.oraclePrice = i64(o);
    if (rec.action === 2) rec.source = EXPLANATIONS[rec.explanation] ?? `explanation ${rec.explanation}`;
    out.push(rec);
  }
  return out;
}

/**
 * Sends fill_perp_order for the taker's order with the given makers (each with its raw User data, to price its other
 * markets). A maker this run has not traded with yet is first reset on the fork (surfnet_resetAccount), so Velocity
 * matches against that maker's live mainnet account; a maker in `traded` keeps its fork copy, so an order that already
 * filled on the fork is not filled again. Returns { signature, err, logs, fills }.
 */
export async function crankFill(conn, forkRpc, filler, takerAuthority, orderId, makers, market = 0, traded = new Set()) {
  for (const m of makers) if (!traded.has(m.user.toBase58())) await rpcCall(forkRpc, "surfnet_resetAccount", [m.user.toBase58(), { includeOwnedAccounts: false }]);
  const perps = new Set([market]), spots = new Set([0]);
  const takerData = (await conn.getAccountInfo(velocityUserAddress(takerAuthority), "confirmed")).data;
  for (const d of [takerData, ...makers.map((m) => m.data)]) { const u = userMarkets(d); u.perps.forEach((p) => perps.add(p)); u.spots.forEach((s) => spots.add(s)); }
  const perpIdx = [...perps].sort((a, b) => a - b), spotIdx = [...spots].sort((a, b) => a - b);
  const spotKeys = spotIdx.map(spotMarketAddress), perpKeys = perpIdx.map(perpMarketAddress);
  const infos = await conn.getMultipleAccountsInfo([...spotKeys, ...perpKeys], "confirmed");
  const oracles = [];
  infos.forEach((info, i) => {
    if (!info) throw new Error(`missing market account ${(i < spotKeys.length ? spotKeys[i] : perpKeys[i - spotKeys.length]).toBase58()}`);
    const off = i < spotKeys.length ? 40 : 312;
    const k = new PublicKey(info.data.subarray(off, off + 32));
    if (!k.equals(PublicKey.default) && !oracles.some((x) => x.equals(k))) oracles.push(k);
  });
  const keys = [r(velocityStateAddress()), { pubkey: filler.publicKey, isSigner: true, isWritable: false }, w(velocityUserAddress(filler.publicKey)), w(statsOf(filler.publicKey)),
    w(velocityUserAddress(takerAuthority)), w(statsOf(takerAuthority)),
    ...oracles.map(r), ...spotKeys.map(w), ...perpKeys.map((k, i) => (perpIdx[i] === market ? w(k) : r(k))), ...makers.flatMap((m) => [w(m.user), w(statsOf(m.authority))])];
  const id = Buffer.alloc(4); id.writeUInt32LE(orderId);
  const data = Buffer.concat([discriminator("global", "fill_perp_order"), Buffer.from([1]), id, Buffer.from([0])]);
  // The fork's clock jumps forward to follow mainnet, which can expire a blockhash before the fill confirms. An expired
  // transaction never lands, so the keeper sends it again with a fresh blockhash (up to 3 tries), as keeper bots do.
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), new TransactionInstruction({ programId: VELOCITY_PROGRAM_ID, keys, data }));
    try {
      const signature = await sendAndConfirmTransaction(conn, tx, [filler], { commitment: "confirmed", skipPreflight: true });
      const got = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = got?.meta?.logMessages ?? [];
      return { signature, err: got?.meta?.err ?? null, logs, fills: decodeFillRecords(logs).filter((x) => x.action === 2 && Number(x.takerOrderId) === orderId), attempts: attempt };
    } catch (e) {
      const msg = String(e.message).split("\n")[0];
      if (attempt < 3 && /expired|block height exceeded|blockhash not found/i.test(msg)) continue;
      return { signature: null, err: msg, logs: e.logs ?? [], fills: [], attempts: attempt };
    }
  }
}
