// Checks the dashboard's data layer against the local validator after client/scripts/demo-seed.mjs.
// Usage: GUARD=<address> node --test dashboard/test/dashboard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDashboard } from "../guard-view.js";

test("dashboard data: counters and decisions match the seeded history", async () => {
  const guard = process.env.GUARD;
  assert.ok(guard, "set GUARD");
  const { guard: g, velocity, decisions } = await loadDashboard(process.env.RPC_URL ?? "http://127.0.0.1:8999", guard);
  assert.equal(g.acceptedCount, 3n);
  assert.deepEqual(Object.fromEntries(Object.entries(g.refused).map(([k, v]) => [k, Number(v)])), { G1: 1, G2: 1, G3: 0, G4: 1, G5: 0, G6: 1, G7: 1 });
  assert.equal(decisions.length, 8, "one decision event per placed order");
  assert.equal(decisions.filter((d) => d.accepted).length, 3);
  assert.equal(velocity.orders.length, 3);
  assert.equal(g.lastRefusal.reason, 6009);
});
