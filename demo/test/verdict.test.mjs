import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, verdictOf } from "../verdict.mjs";

test("reads an accepted order and each refusing rule from the first line of the reply", () => {
  assert.equal(verdictOf("ACCEPTED (accepted): long 1 on SOL-PERP sent to Velocity.\n{}"), "ACCEPTED");
  assert.equal(verdictOf("REFUSED by G1 order size: order too big (value 10, cap 4). Nothing was sent to Velocity.\n{}"), "G1");
  assert.equal(verdictOf("REFUSED by G6 price band: price outside the band (value 500, cap 200). Nothing was sent to Velocity."), "G6");
  assert.equal(verdictOf("REFUSED by G10 daily loss: daily loss cap reached"), "G10");
  assert.equal(verdictOf("CANCELLED 7\n{}"), "CANCELLED");
});

test("G1 is not G10, and a failed call or another answer never counts as the expected one", () => {
  assert.equal(matches("REFUSED by G10 daily loss: x", "G1"), false);
  assert.equal(matches("REFUSED by G1 order size: x", "G10"), false);
  assert.equal(matches("FAILED: network or RPC error: 429", "G6"), false);
  assert.equal(matches("ACCEPTED (accepted): long 1", "G6"), false);
  assert.equal(matches("REFUSED by G4 exposure: x", "ACCEPTED"), false);
  assert.equal(matches("REFUSED by G4 exposure: x", "G4"), true);
  assert.equal(matches("ACCEPTED (accepted): long 1", "ACCEPTED"), true);
});
