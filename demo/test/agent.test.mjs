// The demo agent against the local validator (scripts/local-validator.sh start): the runaway loop ends inside the
// caps with refusals from every rule it runs into; the calm agent is never refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupDemo } from "../setup.mjs";
import { runAgent } from "../agent.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8999";
const quiet = () => {};

test("runaway agent: exposure stays within the cap and every binding rule refuses at least once", async () => {
  const demo = await setupDemo(RPC);
  const s = await runAgent({ mode: "runaway", demo, log: quiet });
  assert.ok(s.exposure <= s.cap, `exposure ${s.exposure} <= cap ${s.cap}`);
  for (const rule of ["G1 order size", "G3 daily notional", "G4 exposure", "G6 price band"]) {
    assert.ok((s.refused[rule] ?? 0) >= 1, `${rule} refused at least once`);
  }
  assert.equal(s.guardAccepted, s.accepted, "on-chain accepted count matches");
  assert.deepEqual(
    { G1: s.guardRefused.G1, G3: s.guardRefused.G3, G4: s.guardRefused.G4, G6: s.guardRefused.G6 },
    { G1: s.refused["G1 order size"], G3: s.refused["G3 daily notional"], G4: s.refused["G4 exposure"], G6: s.refused["G6 price band"] },
    "on-chain refusal counters match what the agent saw",
  );
});

test("calm agent: three small bids, all accepted", async () => {
  const demo = await setupDemo(RPC);
  const s = await runAgent({ mode: "calm", demo, log: quiet });
  assert.equal(s.accepted, 3);
  assert.deepEqual(s.refused, {});
});
