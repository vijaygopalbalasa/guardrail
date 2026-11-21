// Pure, dependency-free reads of the Guardrail program for the dashboard (works in the browser and in Node).
export const GUARD_PROGRAM_ID = "BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy";
export const VELOCITY_PROGRAM_ID = "vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P";
const DISC_GUARD = "36bb5489c00f4af8"; // sha256("account:Guard")[0..8]
const DISC_EVENT = "5e423129c86171fa"; // sha256("event:OrderChecked")[0..8]

export const RULES = {
  0: "accepted", 1: "G1 order size", 2: "G2 allowlist", 3: "G3 daily notional", 4: "G4 exposure",
  5: "G5 leverage", 6: "G6 price band", 7: "G7 paused", 9: "G9 exit",
};
export const REASONS = {
  6000: "OrderTooLarge", 6001: "MarketNotAllowed", 6002: "OrderTypeNotAllowed", 6003: "BuilderFieldsRefused",
  6004: "DailyNotionalExceeded", 6005: "ExposureExceeded", 6006: "LeverageExceeded", 6007: "PriceOutsideBand",
  6008: "StaleOracle", 6009: "Paused", 6013: "NotPerp", 6014: "BitFlagsRefused", 6015: "TriggerOrdersRefused",
  6016: "ZeroSize", 6022: "OtherSpotBalance", 6024: "NonPositiveEquity", 6028: "StaleExitUnfavourable",
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
  g.limits = { maxOrderBase, markets, allowedOrderTypes: r.u8(), dailyNotionalCap: r.u64(), maxLeverageBps: r.u32(), priceBandBps: r.u32(), maxOracleStalenessSlots: r.u64(), exitMaxStalenessSlots: r.u64() };
  g.day = r.i64();
  g.dayNotional = r.u64();
  r.u8();
  g.acceptedCount = r.u64();
  g.refused = { G1: r.u64(), G2: r.u64(), G3: r.u64(), G4: r.u64(), G5: r.u64(), G6: r.u64(), G7: r.u64() };
  g.lastRefusal = { rule: r.u8(), reason: r.u32(), value: r.i128(), cap: r.i128(), slot: r.u64() };
  return g;
}

export function decodeEvents(logs) {
  const out = [];
  for (const l of logs ?? []) {
    if (!l.startsWith("Program data: ")) continue;
    const u8 = fromB64(l.slice(14));
    if (u8.length < 90 || hex(u8.subarray(0, 8)) !== DISC_EVENT) continue;
    const r = new R(u8, 8);
    out.push({ guard: r.key(), accepted: r.u8() === 1, rule: r.u8(), marketIndex: r.u16(), direction: r.u8(), size: r.u64(), reduceOnly: r.u8() === 1, value: r.i128(), cap: r.i128(), reason: r.u32() });
  }
  return out;
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
  return { positions, orders };
}

// ---- RPC
export async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
export async function accountData(url, address) {
  const r = await rpc(url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? fromB64(r.value.data[0]) : null;
}

/** PDA derivation needs ed25519 point checks; the dashboard takes the guard address (or derives it server-side). */
export async function loadDashboard(url, guardAddress, limit = 40) {
  const gd = await accountData(url, guardAddress);
  if (!gd) throw new Error(`no guard account at ${guardAddress}`);
  const guard = decodeGuard(gd);
  const ud = await accountData(url, guard.velocityUser);
  const velocity = ud ? decodeVelocityUser(ud) : { positions: [], orders: [] };
  const sigs = await rpc(url, "getSignaturesForAddress", [guardAddress, { limit, commitment: "confirmed" }]);
  const decisions = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc(url, "getTransaction", [s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    for (const e of decodeEvents(tx?.meta?.logMessages)) decisions.push({ ...e, signature: s.signature, slot: s.slot, blockTime: s.blockTime });
  }
  return { guard, velocity, decisions };
}
