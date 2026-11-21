import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const GUARD_PROGRAM_ID = new PublicKey("BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy");
export const VELOCITY_PROGRAM_ID = new PublicKey("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P");

/** Anchor discriminators: sha256("<namespace>:<name>")[0..8]. */
export function discriminator(namespace: "global" | "account" | "event", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

/** Rule codes carried by the OrderChecked event and the Guard's counters. */
export const RULE_NAMES: Record<number, string> = {
  0: "accepted",
  1: "G1 order size",
  2: "G2 allowlist",
  3: "G3 daily notional",
  4: "G4 exposure",
  5: "G5 leverage",
  6: "G6 price band",
  7: "G7 paused",
  9: "G9 exit",
  10: "G10 daily loss",
};

/** Velocity layout offsets (velocity-v1 IDL, matched to devnet account sizes). */
export const VELOCITY = {
  USER_PERP_POSITIONS: 424,
  PERP_POSITION_LEN: 80,
  USER_SPOT_POSITIONS: 104,
  PERP_MARKET_ORACLE: 312,
  SPOT_MARKET_ORACLE: 40,
};

export const BASE_PRECISION = 1_000_000_000n;
export const PRICE_PRECISION = 1_000_000n;

/** 1.5 -> 1_500_000_000n (SOL base units). */
export function toBase(amount: number): bigint {
  return BigInt(Math.round(amount * 1e9));
}
/** 91.3 -> 91_300_000n (Velocity price units). */
export function toPrice(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6));
}
