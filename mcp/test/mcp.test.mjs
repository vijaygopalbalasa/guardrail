// Spawns the MCP server over stdio and drives it like an agent framework would, against the local validator
// (scripts/local-validator.sh start).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Connection, Keypair } from "@solana/web3.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardrailClient, toBase, ORDER_TYPE_BITS } from "@guardrail/client";
import { key, fund, setupVelocityAccount } from "../../client/test/velocity-setup.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8999";
const conn = new Connection(RPC, "confirmed");

test("MCP: exactly three tools, none changes limits; place (accepted and refused), status, cancel", async () => {
  const dev = key("dev");
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  await fund(conn, dev, owner.publicKey, 5_000_000_000);
  await fund(conn, dev, agent.publicKey, 1_000_000_000);
  await setupVelocityAccount(conn, owner, 1_000);
  await new GuardrailClient(conn).initGuard(owner, agent.publicKey, {
    maxOrderBase: toBase(2), markets: [{ marketIndex: 0, maxExposureBase: toBase(10) }],
    allowedOrderTypes: ORDER_TYPE_BITS.limit, dailyNotionalCap: 1_000_000_000n, maxLeverageBps: 30_000, priceBandBps: 300,
    maxOracleStalenessSlots: 1_000_000n,
  });
  const dir = mkdtempSync(join(tmpdir(), "guardrail-mcp-"));
  const agentPath = join(dir, "agent.json");
  writeFileSync(agentPath, JSON.stringify([...agent.secretKey]), { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    env: { ...process.env, GUARDRAIL_RPC_URL: RPC, GUARDRAIL_AGENT_KEYPAIR: agentPath, GUARDRAIL_OWNER: owner.publicKey.toBase58() },
  });
  const mcp = new Client({ name: "test-agent", version: "0.0.1" });
  await mcp.connect(transport);
  try {
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["guardrail_cancel_order", "guardrail_place_order", "guardrail_status"]);

    const ok = await mcp.callTool({ name: "guardrail_place_order", arguments: { side: "long", size: 1, price: 90, post_only: true } });
    assert.match(ok.content[0].text, /^ACCEPTED/);
    const no = await mcp.callTool({ name: "guardrail_place_order", arguments: { side: "long", size: 5, price: 90, post_only: true } });
    assert.match(no.content[0].text, /^REFUSED by G1 order size: OrderTooLarge/);
    assert.ok(!no.isError, "a refusal is a normal result, not a tool error");
    const mkt = await mcp.callTool({ name: "guardrail_place_order", arguments: { side: "long", size: 1, price: 92, order_type: "market" } });
    assert.match(mkt.content[0].text, /^REFUSED by G2 allowlist: OrderTypeNotAllowed/);

    const st = JSON.parse((await mcp.callTool({ name: "guardrail_status", arguments: {} })).content[0].text);
    assert.equal(st.agent_is_this_server, true);
    assert.equal(st.accepted, "1");
    assert.equal(st.refused.G1, "1");
    assert.equal(st.refused.G2, "1");
    assert.equal(st.open_orders.length, 1);

    const c = await mcp.callTool({ name: "guardrail_cancel_order", arguments: {} });
    assert.match(c.content[0].text, /^CANCELLED/);
    const st2 = JSON.parse((await mcp.callTool({ name: "guardrail_status", arguments: {} })).content[0].text);
    assert.equal(st2.open_orders.length, 0);
  } finally {
    await mcp.close();
  }
});
