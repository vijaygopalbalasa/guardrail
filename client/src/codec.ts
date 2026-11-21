import { PublicKey } from "@solana/web3.js";
import { discriminator } from "./constants.js";

export type Side = "long" | "short";
export type OrderType = "market" | "limit" | "oracle";

export interface OrderInput {
  marketIndex?: number;
  side: Side;
  /** Base units (1e9 = 1 SOL). */
  size: bigint;
  /** Price units (1e6 = $1). Required for market and limit orders, 0 for oracle orders. */
  price?: bigint;
  orderType?: OrderType;
  /** Price units relative to the oracle (oracle orders, or oracle-offset limit orders). */
  oracleOffset?: bigint;
  reduceOnly?: boolean;
  postOnly?: boolean;
  userOrderId?: number;
  /** Unix seconds after which Velocity expires the order (required when the owner sets an order lifetime). */
  maxTs?: bigint;
  auction?: { duration: number; start: bigint; end: bigint };
}

export interface MarketLimit {
  marketIndex: number;
  /** G4 cap in base units; 0 marks the row unused. */
  maxExposureBase: bigint;
}

export interface Limits {
  maxOrderBase: bigint;
  markets: MarketLimit[];
  /** Bitmask: 1 market, 2 limit, 16 oracle. */
  allowedOrderTypes: number;
  dailyNotionalCap: bigint;
  maxLeverageBps: number;
  priceBandBps: number;
  maxOracleStalenessSlots: bigint;
  /** Exits with an older oracle may only be priced on the owner-favourable side of the last price. */
  exitMaxStalenessSlots: bigint;
  /** Non-exit orders must carry maxTs within this many seconds (0: no bound). */
  maxOrderLifetimeSecs?: bigint;
}

export const ORDER_TYPE_BITS = { market: 1, limit: 2, oracle: 16 } as const;

const ORDER_TYPE_TAG: Record<OrderType, number> = { market: 0, limit: 1, oracle: 4 };

class Writer {
  parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); return this; }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this; }
  bytes(b: Buffer | Uint8Array) { this.parts.push(Buffer.from(b)); return this; }
  opt<T>(v: T | undefined | null, f: (x: T) => void) { if (v === undefined || v === null) this.u8(0); else { this.u8(1); f(v); } return this; }
  done() { return Buffer.concat(this.parts); }
}

/** Borsh encoding of Velocity's OrderParams (as the guard mirrors it). */
export function encodeOrderParams(o: OrderInput): Buffer {
  const w = new Writer();
  w.u8(ORDER_TYPE_TAG[o.orderType ?? "limit"]).u8(1 /* perp */).u8(o.side === "long" ? 0 : 1).u8(o.userOrderId ?? 0);
  w.u64(o.size).u64(o.price ?? 0n).u16(o.marketIndex ?? 0).u8(o.reduceOnly ? 1 : 0).u8(o.postOnly ? 1 : 0).u8(0 /* bit_flags */);
  w.opt(o.maxTs, (x) => w.i64(x)); // max_ts
  w.opt(undefined, () => {}); // trigger_price
  w.u8(0); // trigger_condition
  w.opt(o.oracleOffset, (x) => w.i64(x));
  w.opt(o.auction?.duration, (x) => w.u8(x));
  w.opt(o.auction?.start, (x) => w.i64(x));
  w.opt(o.auction?.end, (x) => w.i64(x));
  w.opt(undefined, () => {}); // builder_idx
  w.opt(undefined, () => {}); // builder_fee_tenth_bps
  return w.done();
}

export function encodeLimits(l: Limits): Buffer {
  const w = new Writer();
  w.u64(l.maxOrderBase);
  for (let i = 0; i < 8; i++) {
    const m = l.markets[i] ?? { marketIndex: 0, maxExposureBase: 0n };
    w.u16(m.marketIndex).u64(m.maxExposureBase);
  }
  w.u8(l.allowedOrderTypes).u64(l.dailyNotionalCap).u32(l.maxLeverageBps).u32(l.priceBandBps).u64(l.maxOracleStalenessSlots).u64(l.exitMaxStalenessSlots).u64(l.maxOrderLifetimeSecs ?? 0n);
  return w.done();
}

class Reader {
  o: number;
  constructor(public d: Buffer, o = 0) { this.o = o; }
  u8() { return this.d[this.o++]; }
  bool() { return this.u8() === 1; }
  u16() { const v = this.d.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.d.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.d.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.d.readBigInt64LE(this.o); this.o += 8; return v; }
  i128() { const lo = this.d.readBigUInt64LE(this.o); const hi = this.d.readBigInt64LE(this.o + 8); this.o += 16; return (hi << 64n) + lo; }
  key() { const v = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return v; }
}

export interface LastRefusal { rule: number; reason: number; value: bigint; cap: bigint; slot: bigint }

export interface GuardAccount {
  owner: PublicKey;
  velocityUser: PublicKey;
  agent: PublicKey;
  paused: boolean;
  limits: Limits;
  day: bigint;
  dayNotional: bigint;
  acceptedCount: bigint;
  /** refused.G1 ... refused.G7 */
  refused: Record<"G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7", bigint>;
  lastRefusal: LastRefusal;
  /** Order ids the guard placed; the agent may cancel only these. */
  placedOrderIds: number[];
  cancelCount: bigint;
  refusedCancels: bigint;
  /** The last refusal for each rule code 0..7. */
  lastRefusalByRule: LastRefusal[];
}

function readLimits(r: Reader): Limits {
  const maxOrderBase = r.u64();
  const markets: MarketLimit[] = [];
  for (let i = 0; i < 8; i++) markets.push({ marketIndex: r.u16(), maxExposureBase: r.u64() });
  return {
    maxOrderBase,
    markets,
    allowedOrderTypes: r.u8(),
    dailyNotionalCap: r.u64(),
    maxLeverageBps: r.u32(),
    priceBandBps: r.u32(),
    maxOracleStalenessSlots: r.u64(),
    exitMaxStalenessSlots: r.u64(),
    maxOrderLifetimeSecs: r.u64(),
  };
}

export function decodeGuard(data: Buffer): GuardAccount {
  if (!data.subarray(0, 8).equals(discriminator("account", "Guard"))) throw new Error("not a Guard account");
  const r = new Reader(data, 8);
  const owner = r.key();
  const velocityUser = r.key();
  const agent = r.key();
  const paused = r.bool();
  const limits = readLimits(r);
  const day = r.i64();
  const dayNotional = r.u64();
  r.u8(); // bump
  const acceptedCount = r.u64();
  const refused = { G1: r.u64(), G2: r.u64(), G3: r.u64(), G4: r.u64(), G5: r.u64(), G6: r.u64(), G7: r.u64() };
  const readLr = () => ({ rule: r.u8(), reason: r.u32(), value: r.i128(), cap: r.i128(), slot: r.u64() });
  const lastRefusal = readLr();
  const placedOrderIds: number[] = [];
  for (let i = 0; i < 32; i++) { const id = r.u32(); if (id) placedOrderIds.push(id); }
  r.u8(); // placed_cursor
  const cancelCount = r.u64();
  const refusedCancels = r.u64();
  const lastRefusalByRule = Array.from({ length: 8 }, readLr);
  return { owner, velocityUser, agent, paused, limits, day, dayNotional, acceptedCount, refused, lastRefusal, placedOrderIds, cancelCount, refusedCancels, lastRefusalByRule };
}

export interface OrderChecked {
  guard: PublicKey;
  accepted: boolean;
  rule: number;
  marketIndex: number;
  direction: number;
  size: bigint;
  reduceOnly: boolean;
  value: bigint;
  cap: bigint;
  reason: number;
}

/** Decodes OrderChecked events from a transaction's log lines. */
export function decodeEvents(logs: string[]): OrderChecked[] {
  const d8 = discriminator("event", "OrderChecked");
  const out: OrderChecked[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const d = Buffer.from(line.slice("Program data: ".length), "base64");
    if (d.length < 8 + 82 || !d.subarray(0, 8).equals(d8)) continue;
    const r = new Reader(d, 8);
    out.push({
      guard: r.key(), accepted: r.bool(), rule: r.u8(), marketIndex: r.u16(), direction: r.u8(), size: r.u64(),
      reduceOnly: r.bool(), value: r.i128(), cap: r.i128(), reason: r.u32(),
    });
  }
  return out;
}
