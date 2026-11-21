// Offline security tests for the dashboard (no validator needed): event spoofing, account owners, the RPC
// allowlist and rendering without HTML parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeEvents, checkedGuard, checkedVelocityUser, allowedRpc, b58decode, GUARD_PROGRAM_ID, VELOCITY_PROGRAM_ID } from "../guard-view.js";
import { renderFeed, renderLastRefusal, renderError, renderReplayRun, renderAgentFeed, joinAgentFeed } from "../render.js";

const GUARD = "ihYBqnzinaqysQcbmYetzXkVAVDXM7wWkYr1xWRGZVU";
const OTHER_GUARD = "DsDm2DK29TXgaDMmj8ZdmZ6qGeTmNRnn9V567LvaHyCt";
const EVIL = "Evi1111111111111111111111111111111111111111";

/** Builds an OrderChecked event's "Program data:" line. */
function eventLine({ guard = GUARD, accepted = false, rule = 1, reason = 6000 } = {}) {
  const b = Buffer.alloc(8 + 82);
  createHash("sha256").update("event:OrderChecked").digest().copy(b, 0, 0, 8);
  Buffer.from(b58decode(guard)).copy(b, 8);
  let o = 40;
  b[o++] = accepted ? 1 : 0;
  b[o++] = rule;
  b.writeUInt16LE(0, o); o += 2;
  b[o++] = 0;
  b.writeBigUInt64LE(3_000_000_000n, o); o += 8;
  b[o++] = 0;
  b.writeBigInt64LE(3_000_000_000n, o); o += 16;
  b.writeBigInt64LE(2_000_000_000n, o); o += 16;
  b.writeUInt32LE(reason, o);
  return `Program data: ${b.toString("base64")}`;
}

const frame = (program, inner, depth = 1) => [`Program ${program} invoke [${depth}]`, ...inner, `Program ${program} success`];

test("an event emitted by another program in the same transaction is ignored", () => {
  const logs = [
    ...frame(EVIL, [eventLine({ accepted: true, rule: 0, reason: 0 })]),
    ...frame(GUARD_PROGRAM_ID, [eventLine()]),
  ];
  const ev = decodeEvents(logs, GUARD);
  assert.equal(ev.length, 1, "only the guard program's own event");
  assert.equal(ev[0].accepted, false);
});

test("an event emitted inside a CPI the guard makes (another program executing) is ignored", () => {
  const logs = frame(GUARD_PROGRAM_ID, [
    ...frame(VELOCITY_PROGRAM_ID, [eventLine({ accepted: true, rule: 0, reason: 0 })], 2),
    eventLine({ rule: 4, reason: 6005 }),
  ]);
  const ev = decodeEvents(logs, GUARD);
  assert.deepEqual(ev.map((e) => e.rule), [4]);
});

test("an event naming a different guard is ignored", () => {
  const logs = frame(GUARD_PROGRAM_ID, [eventLine({ guard: OTHER_GUARD })]);
  assert.equal(decodeEvents(logs, GUARD).length, 0);
});

test("accounts with the wrong owner are refused", () => {
  const data = new Uint8Array(400);
  assert.throws(() => checkedGuard({ owner: EVIL, data }), /owner/);
  assert.throws(() => checkedVelocityUser({ owner: EVIL, data: new Uint8Array(4496) }), /owner/);
  assert.throws(() => checkedGuard(null), /no guard/);
});

test("the rpc parameter is limited to an allowlist", () => {
  assert.equal(allowedRpc(null), "http://127.0.0.1:8999");
  assert.equal(allowedRpc("http://localhost:8899"), "http://localhost:8899");
  assert.equal(allowedRpc("http://127.0.0.1:8999"), "http://127.0.0.1:8999");
  assert.equal(allowedRpc("https://api.devnet.solana.com"), "https://api.devnet.solana.com");
  assert.equal(allowedRpc("https://api.mainnet-beta.solana.com"), "https://api.mainnet-beta.solana.com");
  for (const bad of ["https://evil.example", "https://api.devnet.solana.com.evil.example", "javascript:alert(1)", "http://api.devnet.solana.com", "https://user@evil.example"]) {
    assert.equal(allowedRpc(bad), null, bad);
  }
});

// A tiny DOM stand-in: textContent only; setting innerHTML throws.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ""; this.className = ""; this.style = {}; }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  get innerHTML() { throw new Error("innerHTML must not be used"); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(typeof c === "string" ? Object.assign(new El("#text"), { text: c }) : c); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
}
const doc = { createElement: (t) => new El(t), createTextNode: (s) => Object.assign(new El("#text"), { text: String(s) }) };
const HOSTILE = `<img src=x onerror="alert(document.cookie)">`;

test("hostile strings render as text, never as HTML", () => {
  const box = new El("div");
  renderError(doc, box, HOSTILE);
  assert.ok(box.textContent.includes(HOSTILE), "shown literally");
  const feed = new El("div");
  renderFeed(doc, feed, [{ slot: HOSTILE, accepted: false, rule: HOSTILE, reason: HOSTILE, direction: 0, size: 1n, reduceOnly: false, value: 1n, cap: 1n }]);
  assert.ok(feed.textContent.includes(HOSTILE));
  const last = new El("div");
  renderLastRefusal(doc, last, { rule: HOSTILE, reason: HOSTILE, value: 0n, cap: 0n, slot: HOSTILE });
  assert.ok(last.textContent.includes(HOSTILE));
});

test("the dashboard source never assigns innerHTML", () => {
  for (const f of ["app.js", "render.js", "replay.js", "theme.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal((src.match(/innerHTML/g) ?? []).length, 0, `${f} uses innerHTML`);
  }
});

test("replay playback renders hostile strings as text", () => {
  const box = new El("div");
  const run = { title: HOSTILE, limits: HOSTILE, steps: [{ step: 0, price: 91, wants: 1, position: 1, openBids: 0, openAsks: 0, collateral: 1000, upnl: 0, equity: 1000, leverage: 0.1, lossPct: 0, decisions: [{ size: 1, result: "refused", by: HOSTILE }] }] };
  renderReplayRun(doc, box, run, 0, 1000);
  assert.ok(box.textContent.includes(HOSTILE));
});

test("the replay data shows the headline and stays labelled REPLAY", () => {
  const d = JSON.parse(readFileSync(new URL("../replay.json", import.meta.url), "utf8"));
  assert.match(d.label, /^REPLAY/);
  const by = Object.fromEntries(d.runs.map((r) => [r.id, r]));
  assert.equal(by.unguarded.summary.worstLossPct.toFixed(1), "41.2");
  assert.equal(by.guarded.summary.worstLossPct.toFixed(1), "9.4");
  for (const id of ["guarded", "guarded-g3", "guarded-g5"]) assert.equal(by[id].summary.breaches, 0);
  assert.ok(by["guarded-g5"].summary.refusedBy["G5 leverage"] > 0);
});

test("the agent feed renders the model's words as text and pairs orders with chain decisions only when they agree", () => {
  const box = new El("ul");
  const feed = { turns: [
    { turn: 1, reason: HOSTILE, tool: "guardrail_place_order", args: { side: "long", size: 5, price: 91 }, accepted: false, rule: HOSTILE },
    { turn: 2, reason: "Reason: resize", tool: "guardrail_place_order", args: { side: "long", size: 4, price: 91 }, accepted: true },
    { turn: 3, reason: "check", tool: "guardrail_status", args: {} },
  ] };
  const chain = [{ slot: 20n, accepted: true, rule: 0 }, { slot: 10n, accepted: false, rule: 1, value: 5n, cap: 4n, reason: 6000 }];
  const joined = renderAgentFeed(doc, box, feed, chain);
  assert.ok(box.textContent.includes(HOSTILE), "shown literally");
  assert.ok(joined, "joined by slot order");
  assert.equal(joined.get(feed.turns[0]).slot, 10n);
  assert.equal(joinAgentFeed(feed.turns, [chain[0]]), null, "count mismatch: no join");
  assert.equal(joinAgentFeed(feed.turns, [{ slot: 1n, accepted: true }, { slot: 2n, accepted: true }]), null, "verdict mismatch: no join");
});
