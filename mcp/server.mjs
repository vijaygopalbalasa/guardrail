#!/usr/bin/env node
// Guardrail MCP server: gives an AI agent three tools to trade a Velocity perps account THROUGH the guard program.
// It holds only the agent's key. There is deliberately no tool to change limits, rotate the agent, unpause or
// withdraw: those stay with the owner.
//
// Environment:
//   GUARDRAIL_RPC_URL        RPC endpoint (default http://127.0.0.1:8999)
//   GUARDRAIL_AGENT_KEYPAIR  path to the agent's keypair JSON (the key the guard knows as its agent)
//   GUARDRAIL_OWNER          the Velocity account owner's public key (whose guard this is)
//   GUARDRAIL_PROGRAM_ID     optional guard program id
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { GuardrailClient, GuardrailError, velocityUserAddress, RULE_NAMES } from "@guardrail/client";

const env = (k, d) => process.env[k] ?? d;
const rpc = env("GUARDRAIL_RPC_URL", "http://127.0.0.1:8999");
const agentPath = env("GUARDRAIL_AGENT_KEYPAIR");
const ownerStr = env("GUARDRAIL_OWNER");
if (!agentPath || !ownerStr) {
  console.error("set GUARDRAIL_AGENT_KEYPAIR and GUARDRAIL_OWNER");
  process.exit(2);
}
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(agentPath, "utf8"))));
const owner = new PublicKey(ownerStr);
const connection = new Connection(rpc, "confirmed");
const opts = process.env.GUARDRAIL_PROGRAM_ID ? { guardProgramId: new PublicKey(process.env.GUARDRAIL_PROGRAM_ID) } : {};
const client = new GuardrailClient(connection, opts);

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x), 2);
const text = (t) => ({ content: [{ type: "text", text: t }] });
const toUnits = (x, scale) => BigInt(Math.round(x * scale));

const server = new McpServer({ name: "guardrail", version: "0.1.0" });

server.registerTool(
  "guardrail_place_order",
  {
    description:
      "Place a Velocity perp order through the Guardrail guard. The guard checks the owner's limits (order size, allowed markets and order types, daily notional, worst-case exposure, leverage, price band) and either forwards the order to Velocity or refuses it. A refusal is not an error: the result says accepted=false with the rule, the measured value and the cap. Sizes are in the market's base asset (SOL for market 0), prices in USD.",
    inputSchema: {
      side: z.enum(["long", "short"]),
      size: z.number().positive().describe("base asset amount, e.g. 1.5 for 1.5 SOL"),
      price: z.number().nonnegative().optional().describe("limit or worst price in USD (required for limit and market orders)"),
      order_type: z.enum(["limit", "market", "oracle"]).default("limit"),
      oracle_offset: z.number().optional().describe("USD offset from the oracle price (oracle orders)"),
      market_index: z.number().int().nonnegative().default(0).describe("Velocity perp market index (0 = SOL-PERP)"),
      reduce_only: z.boolean().default(false).describe("an exit that only shrinks the position (allowed even when limits are hit or the guard is paused, if its price is inside the band)"),
      post_only: z.boolean().default(false),
    },
  },
  async (a) => {
    try {
      const v = await client.placeOrder({
        agent,
        owner,
        order: {
          side: a.side,
          size: toUnits(a.size, 1e9),
          price: a.price === undefined ? undefined : toUnits(a.price, 1e6),
          orderType: a.order_type,
          oracleOffset: a.oracle_offset === undefined ? undefined : toUnits(a.oracle_offset, 1e6),
          marketIndex: a.market_index,
          reduceOnly: a.reduce_only,
          postOnly: a.post_only,
        },
      });
      const summary = v.accepted
        ? `ACCEPTED (${v.ruleName}): ${a.side} ${a.size} on market ${a.market_index} sent to Velocity.`
        : `REFUSED by ${v.ruleName}: ${v.reasonName} (value ${v.value}, cap ${v.cap}). Nothing was sent to Velocity.`;
      return text(`${summary}\n${json(v)}`);
    } catch (e) {
      if (e instanceof GuardrailError) return { ...text(`FAILED: ${e.message}`), isError: true };
      throw e;
    }
  },
);

server.registerTool(
  "guardrail_cancel_order",
  {
    description: "Cancel an open order through the guard (always allowed, even while the guard is paused). Omit order_id to cancel the latest order.",
    inputSchema: { order_id: z.number().int().nonnegative().optional() },
  },
  async (a) => {
    try {
      const r = await client.cancelOrder({ agent, owner, orderId: a.order_id });
      return text(`CANCELLED ${a.order_id ?? "latest order"}\n${json(r)}`);
    } catch (e) {
      if (e instanceof GuardrailError) return { ...text(`FAILED: ${e.message}`), isError: true };
      throw e;
    }
  },
);

server.registerTool(
  "guardrail_status",
  {
    description: "Read the guard: the owner's limits, whether it is paused, orders accepted and refused by rule, the last refusal, and the account's open orders and positions on Velocity.",
    inputSchema: {},
  },
  async () => {
    const g = await client.getGuard(owner);
    const d = (await connection.getAccountInfo(velocityUserAddress(owner), "confirmed")).data;
    const positions = [];
    for (let i = 0; i < 8; i++) {
      const o = 424 + i * 80;
      const base = d.readBigInt64LE(o + 8);
      const bids = d.readBigInt64LE(o + 40);
      const asks = d.readBigInt64LE(o + 48);
      if (base !== 0n || bids !== 0n || asks !== 0n) positions.push({ market_index: d.readUInt16LE(o + 76), base, quote: d.readBigInt64LE(o + 16), open_bids: bids, open_asks: asks });
    }
    const orders = [];
    for (let i = 0; i < 32; i++) {
      const o = 1064 + i * 104;
      if (d[o + 86] === 1) orders.push({ order_id: d.readUInt32LE(o + 80), market_index: d.readUInt16LE(o + 84), side: d[o + 91] === 0 ? "long" : "short", price: d.readBigUInt64LE(o + 8), size: d.readBigUInt64LE(o + 16), filled: d.readBigUInt64LE(o + 24) });
    }
    const status = {
      agent_is_this_server: g.agent.equals(agent.publicKey),
      paused: g.paused,
      limits: g.limits,
      accepted: g.acceptedCount,
      refused: g.refused,
      last_refusal: { ...g.lastRefusal, rule_name: RULE_NAMES[g.lastRefusal.rule] ?? null },
      today_notional: g.dayNotional,
      positions,
      open_orders: orders,
      units: "sizes in base units (1e9 = 1 SOL), prices and notional in 1e6 = 1 USD",
    };
    return text(json(status));
  },
);

await server.connect(new StdioServerTransport());
