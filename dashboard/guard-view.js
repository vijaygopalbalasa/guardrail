// Pure, dependency-free reads of the Guardrail program for the dashboard (works in the browser and in Node).
export const GUARD_PROGRAM_ID = "BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy";
export const VELOCITY_PROGRAM_ID = "vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P";
const DISC_GUARD = "36bb5489c00f4af8"; // sha256("account:Guard")[0..8]
const DISC_EVENT = "5e423129c86171fa"; // sha256("event:OrderChecked")[0..8]

export const RULES = {
  0: "accepted", 1: "G1 order size", 2: "G2 allowlist", 3: "G3 daily notional", 4: "G4 exposure",
  5: "G5 leverage", 6: "G6 price band", 7: "G7 paused", 9: "G9 exit", 10: "G10 daily loss",
};
export const REASONS = {
  6000: "OrderTooLarge", 6001: "MarketNotAllowed", 6002: "OrderTypeNotAllowed", 6003: "BuilderFieldsRefused",
  6004: "DailyNotionalExceeded", 6005: "ExposureExceeded", 6006: "LeverageExceeded", 6007: "PriceOutsideBand",
  6008: "StaleOracle", 6009: "Paused", 6013: "NotPerp", 6014: "BitFlagsRefused", 6015: "TriggerOrdersRefused",
  6016: "ZeroSize", 6022: "OtherSpotBalance", 6024: "NonPositiveEquity", 6028: "StaleExitUnfavourable", 6029: "CancelNotAllowed", 6030: "OrderLifetimeTooLong", 6031: "TooManyOpenOrders", 6032: "DailyLossExceeded", 6033: "OrderNotStored", 6034: "ReduceOnlyBeyondPosition", 6035: "KeeperRequired", 6036: "BadGuardAccount", 6037: "KeeperIsAgent",
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c === "1") out.unshift(0); else break; }
  while (out.length < 32) out.unshift(0);
  return new Uint8Array(out);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

class R {
  constructor(u8, o = 0) { this.u = u8; this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.o = o; }
  u8() { return this.u[this.o++]; }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  i128() { const lo = this.v.getBigUint64(this.o, true); const hi = this.v.getBigInt64(this.o + 8, true); this.o += 16; return (hi << 64n) + lo; }
  key() { const k = b58encode(this.u.subarray(this.o, this.o + 32)); this.o += 32; return k; }
}

export function decodeGuard(u8) {
  if (hex(u8.subarray(0, 8)) !== DISC_GUARD) throw new Error("not a Guard account");
  const r = new R(u8, 8);
  const g = { owner: r.key(), velocityUser: r.key(), agent: r.key(), paused: r.u8() === 1 };
  const maxOrderBase = r.u64();
  const markets = [];
  for (let i = 0; i < 8; i++) { const m = { marketIndex: r.u16(), maxExposureBase: r.u64() }; if (m.maxExposureBase > 0n) markets.push(m); }
  g.limits = { maxOrderBase, markets, allowedOrderTypes: r.u8(), dailyNotionalCap: r.u64(), maxLeverageBps: r.u32(), priceBandBps: r.u32(), maxOracleStalenessSlots: r.u64(), exitMaxStalenessSlots: r.u64(), maxOrderLifetimeSecs: r.u64() };
  g.day = r.i64();
  g.dayNotional = r.u64();
  r.u8();
  g.acceptedCount = r.u64();
  g.refused = { G1: r.u64(), G2: r.u64(), G3: r.u64(), G4: r.u64(), G5: r.u64(), G6: r.u64(), G7: r.u64() };
  g.lastRefusal = { rule: r.u8(), reason: r.u32(), value: r.i128(), cap: r.i128(), slot: r.u64() };
  g.placedOrderIds = [];
  for (let i = 0; i < 32; i++) { const id = r.u32(); if (id) g.placedOrderIds.push(id); }
  r.u8();
  g.cancelCount = r.u64();
  g.refusedCancels = r.u64();
  r.o += 8 * 45; // last refusal by rule
  // G10 fields, absent on guards created before G10.
  if (u8.length >= r.o + 8 * 5 + 45) {
    g.dailyLoss = { max: r.u64(), day: r.i64(), baselineEquity: r.i64(), baselineFlows: r.i64() };
    g.refused.G10 = r.u64();
    r.o += 45 + 8 + 8 + 1; // last G10 refusal, last equity seen, its deposits, has_last_seen
    if (u8.length >= r.o + 32) g.dailyLoss.keeper = r.key();
  }
  return g;
}

/**
 * OrderChecked events emitted by the guard program itself, for this guard only. The log stack is tracked from the
 * "Program <id> invoke [n]" and "Program <id> success|failed" lines, and a "Program data:" line counts only while
 * the guard program is the executing frame (another program in the same transaction, or one the guard calls, can
 * log anything). The event's guard field must equal `guardAddress`.
 */
export function decodeEvents(logs, guardAddress, programId = GUARD_PROGRAM_ID) {
  const out = [];
  const stack = [];
  for (const l of logs ?? []) {
    const inv = /^Program (\w+) invoke \[(\d+)\]$/.exec(l);
    if (inv) { stack.length = Number(inv[2]) - 1; stack.push(inv[1]); continue; }
    const end = /^Program (\w+) (success|failed)/.exec(l);
    if (end) { if (stack[stack.length - 1] === end[1]) stack.pop(); continue; }
    if (!l.startsWith("Program data: ") || stack[stack.length - 1] !== programId) continue;
    const u8 = fromB64(l.slice(14));
    if (u8.length < 90 || hex(u8.subarray(0, 8)) !== DISC_EVENT) continue;
    const r = new R(u8, 8);
    const e = { guard: r.key(), accepted: r.u8() === 1, rule: r.u8(), marketIndex: r.u16(), direction: r.u8(), size: r.u64(), reduceOnly: r.u8() === 1, value: r.i128(), cap: r.i128(), reason: r.u32() };
    if (e.guard === guardAddress) out.push(e);
  }
  return out;
}

/** The Guard account, only if the guard program owns it. */
export function checkedGuard(info, programId = GUARD_PROGRAM_ID) {
  if (!info) throw new Error("no guard account");
  if (info.owner !== programId) throw new Error(`guard account owner is ${info.owner}, expected the guard program ${programId}`);
  return decodeGuard(info.data);
}

/** The Velocity User account, only if the Velocity program owns it. */
export function checkedVelocityUser(info) {
  if (!info) return { positions: [], orders: [] };
  if (info.owner !== VELOCITY_PROGRAM_ID) throw new Error(`Velocity user owner is ${info.owner}, expected ${VELOCITY_PROGRAM_ID}`);
  if (info.data.length < 4496) throw new Error("Velocity user account too short");
  return decodeVelocityUser(info.data);
}

/** The RPC endpoints the page may read from: local validators and Solana's public devnet and mainnet RPC. */
export function allowedRpc(param) {
  if (param === null || param === undefined || param === "") return "http://127.0.0.1:8999";
  let u;
  try { u = new URL(param); } catch { return null; }
  if (u.username || u.password) return null;
  const local = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (u.protocol === "http:" || u.protocol === "https:");
  const publicRpc = u.protocol === "https:" && (u.hostname === "api.devnet.solana.com" || u.hostname === "api.mainnet-beta.solana.com") && !u.port;
  return local || publicRpc ? u.origin : null;
}

/** Velocity positions and open orders from the User account bytes. */
export function decodeVelocityUser(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const positions = [];
  for (let i = 0; i < 8; i++) {
    const o = 424 + i * 80;
    const p = { marketIndex: v.getUint16(o + 76, true), base: v.getBigInt64(o + 8, true), quote: v.getBigInt64(o + 16, true), openBids: v.getBigInt64(o + 40, true), openAsks: v.getBigInt64(o + 48, true) };
    if (p.base || p.openBids || p.openAsks) positions.push(p);
  }
  const orders = [];
  for (let i = 0; i < 32; i++) {
    const o = 1064 + i * 104;
    if (u8[o + 86] === 1) orders.push({ orderId: v.getUint32(o + 80, true), marketIndex: v.getUint16(o + 84, true), side: u8[o + 91] === 0 ? "long" : "short", price: v.getBigUint64(o + 8, true), size: v.getBigUint64(o + 16, true), filled: v.getBigUint64(o + 24, true) });
  }
  const spot = [];
  for (let i = 0; i < 8; i++) {
    const o = 104 + i * 40;
    const sp = { scaledBalance: v.getBigUint64(o, true), marketIndex: v.getUint16(o + 32, true), balanceType: u8[o + 34] };
    if (sp.scaledBalance) spot.push(sp);
  }
  const totalDeposits = u8.length >= 4408 ? v.getBigUint64(4392, true) : 0n;
  const totalWithdraws = u8.length >= 4408 ? v.getBigUint64(4400, true) : 0n;
  return { positions, orders, spot, totalDeposits, totalWithdraws };
}

// Velocity's spot market 0 (the quote asset) and perp market 0 (SOL-PERP): the same PDAs on devnet and mainnet.
export const SPOT0 = "2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc";
export const PERP0 = "FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY";

/** The quote asset's name from spot market 0's mint: USDT on mainnet (and forks of it), dUSDT (Velocity's devnet faucet token) otherwise. */
export const MAINNET_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const quoteUnitOf = (mint) => (mint === MAINNET_USDT_MINT ? "USDT" : "dUSDT");
const quoteCache = new Map();
async function loadQuoteUnit(url) {
  if (!quoteCache.has(url)) {
    const sm = await accountInfo(url, SPOT0);
    quoteCache.set(url, quoteUnitOf(sm && sm.owner === VELOCITY_PROGRAM_ID && sm.data.length >= 104 ? b58encode(sm.data.subarray(72, 104)) : null));
  }
  return quoteCache.get(url);
}

/**
 * Equity (collateral + unrealized PnL, quote units 1e6) and net deposits, computed the way the guard does it:
 * Quote deposits at the spot market's cumulative interest, plus base x oracle price + quote on SOL-PERP.
 * Returns null for anything the page cannot price (other markets, other spot balances, a bad oracle).
 */
export function equityOf(velocity, spotMarketU8, oracleU8) {
  if (velocity.positions.some((p) => p.marketIndex !== 0)) return null;
  if (velocity.spot.some((x) => x.marketIndex !== 0 || x.balanceType === 1)) return null;
  const sv = new DataView(spotMarketU8.buffer, spotMarketU8.byteOffset, spotMarketU8.byteLength);
  const cdiLo = sv.getBigUint64(328, true), cdiHi = sv.getBigUint64(336, true);
  const cdi = (cdiHi << 64n) + cdiLo;
  const decimals = sv.getUint32(696, true);
  if (decimals > 19) return null;
  let collateral = 0n;
  for (const x of velocity.spot) collateral += (x.scaledBalance * cdi) / 10n ** BigInt(19 - decimals);
  const ov = new DataView(oracleU8.buffer, oracleU8.byteOffset, oracleU8.byteLength);
  const price = ov.getBigInt64(8, true), exponent = ov.getInt32(32, true);
  if (price <= 0n || exponent < -18 || exponent > 18) return null;
  const shift = exponent + 6;
  const p6 = shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
  let upnl = 0n;
  for (const p of velocity.positions) upnl += (p.base * p6) / 1_000_000_000n + p.quote;
  return { equity: collateral + upnl, flows: velocity.totalDeposits - velocity.totalWithdraws };
}

async function loadEquity(url, velocity) {
  const r = await rpc(url, "getMultipleAccounts", [[SPOT0, PERP0], { encoding: "base64", commitment: "confirmed" }]);
  const [sm, pm] = r.value;
  if (!sm || !pm || sm.owner !== VELOCITY_PROGRAM_ID || pm.owner !== VELOCITY_PROGRAM_ID) return null;
  const pmU8 = fromB64(pm.data[0]);
  const oracle = b58encode(pmU8.subarray(312, 344));
  const o = await accountInfo(url, oracle);
  if (!o || o.owner !== VELOCITY_PROGRAM_ID || o.data.length < 48) return null;
  return equityOf(velocity, fromB64(sm.data[0]), o.data);
}

// ---- RPC
export async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
export async function accountInfo(url, address) {
  const r = await rpc(url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? { owner: r.value.owner, data: fromB64(r.value.data[0]) } : null;
}

// Decoded transactions by signature, so a refresh only fetches new ones (public RPCs rate-limit).
const txCache = new Map();

export async function loadDashboard(url, guardAddress, limit = 40, paceMs = 0) {
  const guard = checkedGuard(await accountInfo(url, guardAddress));
  const velocity = checkedVelocityUser(await accountInfo(url, guard.velocityUser));
  const sigs = await rpc(url, "getSignaturesForAddress", [guardAddress, { limit, commitment: "confirmed" }]);
  const decisions = [];
  const checkpoints = [];
  for (const s of sigs) {
    if (s.err) continue;
    if (!txCache.has(s.signature)) {
      // On a rate-limited public RPC, show what is decoded so far and pick up the rest on the next refresh.
      let tx;
      try {
        if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
        tx = await rpc(url, "getTransaction", [s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      } catch {
        break;
      }
      const logs = tx?.meta?.logMessages ?? [];
      const events = decodeEvents(logs, guardAddress);
      events.checkpoint = logs.some((l) => typeof l === "string" && l.startsWith("Program log: guard: checkpoint"));
      txCache.set(s.signature, events);
    }
    const cached = txCache.get(s.signature);
    if (cached.checkpoint) checkpoints.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime });
    for (const e of cached) decisions.push({ ...e, signature: s.signature, slot: s.slot, blockTime: s.blockTime });
  }
  let equity = null;
  if (guard.dailyLoss && guard.dailyLoss.max > 0n) {
    try { equity = await loadEquity(url, velocity); } catch { /* the G10 meter is skipped */ }
  }
  velocity.equity = equity;
  let slot = null;
  try { slot = await rpc(url, "getSlot", [{ commitment: "confirmed" }]); } catch { /* shown without a slot */ }
  let quote = "dUSDT";
  try { quote = await loadQuoteUnit(url); } catch { /* the devnet unit */ }
  return { guard, velocity, decisions, slot, checkpoints, quote };
}
