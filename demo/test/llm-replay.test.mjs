// Offline: replays a recorded language-model transcript (notes/llm-transcript-runaway-local.jsonl) through
// guardrail-mcp against the local validator, with no API call, and checks the guard gives the same verdicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDemo } from "../setup.mjs";
import { runLlmAgent } from "../agent-llm.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8999";

test("a recorded model transcript replays offline with the same guard verdicts", async () => {
  const rec = readFileSync(new URL("../../notes/llm-transcript-runaway-local.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const decide = async (_messages, turn) => {
    const r = rec[turn];
    return { reason: r.reason, tool: r.tool, args: r.args ?? {}, usage: null };
  };
  const demo = await setupDemo(RPC);
  const outcomes = [];
  const s = await runLlmAgent({ mode: "runaway", demo, turns: rec.length, decide, log: (l) => outcomes.push(l) });
  const place = rec.filter((r) => r.tool === "guardrail_place_order");
  assert.equal(s.accepted, place.filter((r) => r.accepted).length, "same number accepted");
  const refused = {};
  for (const r of place.filter((r) => r.accepted === false)) refused[r.rule] = (refused[r.rule] ?? 0) + 1;
  assert.deepEqual(s.refused, refused, "same refusals by rule");
  assert.ok(s.exposure <= s.cap);
  assert.equal(s.model, "recorded transcript");
});
