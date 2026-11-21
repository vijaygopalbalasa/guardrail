import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { GUARD_PROGRAM_ID, VELOCITY_PROGRAM_ID, VELOCITY, RULE_NAMES, discriminator } from "./constants.js";
import { GUARD_ERRORS } from "./errors.js";
import { decodeEvents, decodeGuard, encodeLimits, encodeOrderParams, type GuardAccount, type Limits, type OrderInput } from "./codec.js";

export interface Verdict {
  accepted: boolean;
  /** Rule code: 0 accepted, 1..7 = G1..G7, 9 = G9 exit. */
  rule: number;
  ruleName: string;
  /** The measured value for the rule and the owner's cap (units depend on the rule). */
  value: bigint;
  cap: bigint;
  /** Guard error code naming the refusal (0 when accepted) and its name. */
  reason: number;
  reasonName: string | null;
  signature: string;
  /** Whether the order went in as reduce-only (set automatically for an order that only shrinks the position). */
  reduceOnly: boolean;
}

/** A transaction the guard (or Velocity) rejected outright: wrong agent, bad accounts, stale oracle, Velocity error. */
export class GuardrailError extends Error {
  constructor(message: string, public code: number | null, public codeName: string | null, public logs: string[]) {
    super(message);
  }
}

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

export function velocityUserAddress(authority: PublicKey, subAccount = 0): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("user"), authority.toBuffer(), u16le(subAccount)], VELOCITY_PROGRAM_ID)[0];
}
export function guardAddress(velocityUser: PublicKey, programId = GUARD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("guard"), velocityUser.toBuffer()], programId)[0];
}
export function perpMarketAddress(index: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("perp_market"), u16le(index)], VELOCITY_PROGRAM_ID)[0];
}
export function spotMarketAddress(index: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("spot_market"), u16le(index)], VELOCITY_PROGRAM_ID)[0];
}
export const velocityStateAddress = () =>
  PublicKey.findProgramAddressSync([Buffer.from("velocity_state")], VELOCITY_PROGRAM_ID)[0];

export interface ClientOptions {
  guardProgramId?: PublicKey;
  /** Compute unit limit for trade transactions (default 800k). */
  computeUnits?: number;
}

export class GuardrailClient {
  readonly programId: PublicKey;
  readonly computeUnits: number;
  constructor(public connection: Connection, opts: ClientOptions = {}) {
    this.programId = opts.guardProgramId ?? GUARD_PROGRAM_ID;
    this.computeUnits = opts.computeUnits ?? 800_000;
  }

  guardFor(owner: PublicKey): { velocityUser: PublicKey; guard: PublicKey } {
    const velocityUser = velocityUserAddress(owner);
    return { velocityUser, guard: guardAddress(velocityUser, this.programId) };
  }

  /** The Guard account: limits, counters (accepted and refused by rule) and the last refusal. */
  async getGuard(owner: PublicKey): Promise<GuardAccount> {
    const { guard } = this.guardFor(owner);
    const acc = await this.connection.getAccountInfo(guard, "confirmed");
    if (!acc) throw new Error(`no guard at ${guard.toBase58()}`);
    return decodeGuard(acc.data);
  }

  /**
   * Velocity's account maps for an order: oracles, then spot market 0, then perp markets (the order's market and
   * every market where the user has a position or open order). Each market's own oracle is read from its account.
   */
  async remainingAccounts(velocityUser: PublicKey, marketIndex: number): Promise<AccountMeta[]> {
    const markets = new Set<number>([marketIndex]);
    const user = await this.connection.getAccountInfo(velocityUser, "confirmed");
    if (user) {
      for (let i = 0; i < 8; i++) {
        const o = VELOCITY.USER_PERP_POSITIONS + i * VELOCITY.PERP_POSITION_LEN;
        const active = [8, 16, 40, 48].some((f) => user.data.readBigInt64LE(o + f) !== 0n) || user.data[o + 78] !== 0;
        if (active) markets.add(user.data.readUInt16LE(o + 76));
      }
    }
    const perps = [...markets].map(perpMarketAddress);
    const spot0 = spotMarketAddress(0);
    const infos = await this.connection.getMultipleAccountsInfo([spot0, ...perps], "confirmed");
    const oracles: PublicKey[] = [];
    const add = (k: PublicKey) => { if (!oracles.some((x) => x.equals(k))) oracles.push(k); };
    infos.forEach((info, i) => {
      if (!info) throw new Error(`missing Velocity market account ${(i === 0 ? spot0 : perps[i - 1]).toBase58()}`);
      add(new PublicKey(info.data.subarray(...(i === 0
        ? [VELOCITY.SPOT_MARKET_ORACLE, VELOCITY.SPOT_MARKET_ORACLE + 32]
        : [VELOCITY.PERP_MARKET_ORACLE, VELOCITY.PERP_MARKET_ORACLE + 32]) as [number, number])));
    });
    return [
      ...oracles.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      { pubkey: spot0, isSigner: false, isWritable: true },
      ...perps.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ];
  }

  private tradeKeys(agent: PublicKey, owner: PublicKey, extra: AccountMeta[]): AccountMeta[] {
    const { velocityUser, guard } = this.guardFor(owner);
    return [
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: guard, isSigner: false, isWritable: true },
      { pubkey: velocityStateAddress(), isSigner: false, isWritable: false },
      { pubkey: velocityUser, isSigner: false, isWritable: true },
      { pubkey: VELOCITY_PROGRAM_ID, isSigner: false, isWritable: false },
      ...extra,
    ];
  }

  private nonce = 0;

  private async send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<{ signature: string; logs: string[] }> {
    // Vary the compute-unit limit per call so two identical orders in the same slot are distinct transactions.
    this.nonce = (this.nonce + 1) % 10_000;
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnits - this.nonce }), ...ixs);
    let logs: string[] = [];
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      const signature = await this.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
      // Poll for confirmation over HTTP (no websocket), which public RPCs rate-limit less.
      let status: { err: unknown } | null = null;
      for (let i = 0; i < 120 && !status; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = (await this.connection.getSignatureStatuses([signature])).value[0];
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) status = { err: s.err };
        else if (i % 10 === 9 && (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      }
      if (!status) throw new Error(`transaction ${signature} was not confirmed`);
      let got = null;
      for (let i = 0; i < 20 && !got; i++) {
        got = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!got) await new Promise((r) => setTimeout(r, 500));
      }
      logs = got?.meta?.logMessages ?? [];
      if (status.err) throw Object.assign(new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`), { logs });
      return { signature, logs };
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[]; getLogs?: (c: Connection) => Promise<string[]> };
      logs = err.logs ?? (err.getLogs ? await err.getLogs(this.connection).catch(() => []) : logs);
      const all = `${err.message ?? ""}\n${logs.join("\n")}`;
      const m = /custom program error: 0x([0-9a-f]+)/i.exec(all) ?? /"Custom":(\d+)/.exec(all) ?? /Error Number: (\d+)/.exec(all);
      const code = m ? (m[0].includes("0x") ? parseInt(m[1], 16) : parseInt(m[1], 10)) : null;
      const name = code !== null ? (GUARD_ERRORS[code] ?? null) : null;
      throw new GuardrailError(`transaction failed${name ? `: ${name}` : ""}: ${(err.message ?? "").split("\n")[0]}`, code, name, logs);
    }
  }

  /**
   * Places an order through the guard as the agent. Resolves with the guard's verdict: refused orders are recorded
   * successes (Velocity is not called), so `accepted: false` comes back with the rule, value, cap and reason.
   */
  /**
   * True when `order` opposes the current position on its market and, together with the reduce-only orders already
   * resting on that side, is no larger than the position: an exit that only shrinks it.
   */
  async wouldOnlyReduce(owner: PublicKey, order: OrderInput): Promise<boolean> {
    const info = await this.connection.getAccountInfo(this.guardFor(owner).velocityUser, "confirmed");
    if (!info) return false;
    const d = info.data;
    const market = order.marketIndex ?? 0;
    let base = 0n;
    for (let i = 0; i < 8; i++) {
      const o = 424 + i * 80;
      if (d.readUInt16LE(o + 76) === market) base += d.readBigInt64LE(o + 8);
    }
    const dir = order.side === "long" ? 0 : 1;
    if (base === 0n || (base > 0n ? dir !== 1 : dir !== 0)) return false;
    let resting = 0n;
    for (let i = 0; i < 32; i++) {
      const o = 1064 + i * 104;
      if (d[o + 86] === 1 && d.readUInt16LE(o + 84) === market && d[o + 91] === dir && d[o + 92] === 1) resting += d.readBigUInt64LE(o + 16) - d.readBigUInt64LE(o + 24);
    }
    const abs = base < 0n ? -base : base;
    return order.size + resting <= abs;
  }

  /**
   * Places an order through the guard. When `order.reduceOnly` is left unset, an order that only shrinks the position
   * goes in as reduce-only (an exit the guard always lets through inside the band).
   */
  async placeOrder(args: { agent: Keypair; owner: PublicKey; order: OrderInput; payer?: Keypair }): Promise<Verdict> {
    if (args.order.reduceOnly === undefined) args = { ...args, order: { ...args.order, reduceOnly: await this.wouldOnlyReduce(args.owner, args.order) } };
    const { velocityUser } = this.guardFor(args.owner);
    const extra = await this.remainingAccounts(velocityUser, args.order.marketIndex ?? 0);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: this.tradeKeys(args.agent.publicKey, args.owner, extra),
      data: Buffer.concat([discriminator("global", "place_perp_order"), encodeOrderParams(args.order)]),
    });
    const signers = args.payer && !args.payer.publicKey.equals(args.agent.publicKey) ? [args.payer, args.agent] : [args.agent];
    const { signature, logs } = await this.send([ix], signers);
    const ev = decodeEvents(logs)[0];
    if (!ev) throw new GuardrailError("no OrderChecked event in the transaction logs", null, null, logs);
    return {
      accepted: ev.accepted, rule: ev.rule, ruleName: RULE_NAMES[ev.rule] ?? `rule ${ev.rule}`, value: ev.value, cap: ev.cap,
      reason: ev.reason, reasonName: ev.reason ? (GUARD_ERRORS[ev.reason] ?? null) : null, signature, reduceOnly: ev.reduceOnly,
    };
  }

  /** Open order ids on the Velocity account that the guard placed (the only ones the agent may cancel). */
  async guardOrders(owner: PublicKey): Promise<number[]> {
    const g = await this.getGuard(owner);
    const d = (await this.connection.getAccountInfo(this.guardFor(owner).velocityUser, "confirmed"))!.data;
    const open: number[] = [];
    for (let i = 0; i < 32; i++) { const o = 1064 + i * 104; if (d[o + 86] === 1) open.push(d.readUInt32LE(o + 80)); }
    return open.filter((id) => g.placedOrderIds.includes(id)).sort((a, b) => a - b);
  }

  /**
   * Cancels one order the guard placed (by default the most recent one still open). Always allowed, even while
   * paused. The guard refuses (as a recorded success) a cancel of the owner's own orders or a cancel-all.
   */
  async cancelOrder(args: { agent: Keypair; owner: PublicKey; orderId?: number; payer?: Keypair }): Promise<{ signature: string; accepted: boolean; orderId: number | null }> {
    const { velocityUser } = this.guardFor(args.owner);
    const extra = await this.remainingAccounts(velocityUser, 0);
    const target = args.orderId ?? (await this.guardOrders(args.owner)).at(-1);
    if (target === undefined) return { signature: "", accepted: false, orderId: null };
    const id = Buffer.concat([Buffer.from([1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(target); return b; })()]);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: this.tradeKeys(args.agent.publicKey, args.owner, extra),
      data: Buffer.concat([discriminator("global", "cancel_order"), id]),
    });
    const signers = args.payer && !args.payer.publicKey.equals(args.agent.publicKey) ? [args.payer, args.agent] : [args.agent];
    const { signature, logs } = await this.send([ix], signers);
    const accepted = !logs.some((l) => l.includes("guard REFUSED cancel"));
    return { signature, accepted, orderId: target };
  }

  // ----- owner-only (never exposed to the agent) -----

  /** Creates the guard and makes it the Velocity user's delegate, in one transaction signed by the owner. */
  async initGuard(owner: Keypair, agent: PublicKey, limits: Limits): Promise<{ signature: string; guard: PublicKey }> {
    const { velocityUser, guard } = this.guardFor(owner.publicKey);
    const init = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: velocityUser, isSigner: false, isWritable: false },
        { pubkey: guard, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator("global", "init_guard"), agent.toBuffer(), encodeLimits(limits)]),
    });
    const delegate = new TransactionInstruction({
      programId: VELOCITY_PROGRAM_ID,
      keys: [
        { pubkey: velocityUser, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([discriminator("global", "update_user_delegate"), u16le(0), guard.toBuffer()]),
    });
    const { signature } = await this.send([init, delegate], [owner]);
    return { signature, guard };
  }

  private ownerIx(name: string, owner: PublicKey, args: Buffer): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: false },
        { pubkey: this.guardFor(owner).guard, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([discriminator("global", name), args]),
    });
  }
  async setLimits(owner: Keypair, limits: Limits) { return this.send([this.ownerIx("set_limits", owner.publicKey, encodeLimits(limits))], [owner]); }
  /** PublicKey.default revokes the agent. */
  async setAgent(owner: Keypair, agent: PublicKey) { return this.send([this.ownerIx("set_agent", owner.publicKey, agent.toBuffer())], [owner]); }
  /**
   * G10, permissionless: anyone (`payer`) takes the day's baseline for `owner`'s guard with fresh prices. Signed by the
   * owner or the owner's keeper in the first hour of a UTC day, it marks the day at the equity then.
   */
  async checkpoint(payer: Keypair, owner: PublicKey) {
    const { velocityUser, guard } = this.guardFor(owner);
    const extra = await this.remainingAccounts(velocityUser, 0);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }, { pubkey: guard, isSigner: false, isWritable: true }, { pubkey: velocityUser, isSigner: false, isWritable: false }, ...extra],
      data: discriminator("global", "checkpoint"),
    });
    return this.send([ix], [payer]);
  }

  /** G10: the most equity (quote units, 1e6 = 1 dUSDT) the account may lose in one UTC day; 0 turns it off. */
  async setDailyLoss(owner: Keypair, maxDailyLoss: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(maxDailyLoss); return this.send([this.ownerIx("set_daily_loss", owner.publicKey, b)], [owner]); }
  /** Owner only: grows a guard made by an older program version to the current size (the owner pays the rent). */
  async migrateGuard(owner: Keypair) { return this.send([this.guardByOwnerIx("migrate_guard", owner.publicKey)], [owner]); }

  /**
   * Owner only: closes the guard and returns its rent. Remove the guard as the Velocity account's delegate separately
   * (Velocity's update_user_delegate) before trading directly again; init_guard can then run again.
   */
  async closeGuard(owner: Keypair) { return this.send([this.guardByOwnerIx("close_guard", owner.publicKey)], [owner]); }

  private guardByOwnerIx(name: string, owner: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: this.guardFor(owner).guard, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator("global", name),
    });
  }

  /** G10: the keeper whose first-hour checkpoint marks the day at midnight (PublicKey.default for none). */
  async setKeeper(owner: Keypair, keeper: PublicKey) { return this.send([this.ownerIx("set_keeper", owner.publicKey, keeper.toBuffer())], [owner]); }
  async setPaused(owner: Keypair, paused: boolean) { return this.send([this.ownerIx("set_paused", owner.publicKey, Buffer.from([paused ? 1 : 0]))], [owner]); }
}
