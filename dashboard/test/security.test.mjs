// Offline security tests for the dashboard (no validator needed): event spoofing, account owners, the RPC
// allowlist and rendering without HTML parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeEvents, checkedGuard, checkedVelocityUser, allowedRpc, b58decode, equityOf, quoteUnitOf, GUARD_PROGRAM_ID, VELOCITY_PROGRAM_ID } from "../guard-view.js";
import { renderFeed, renderLastRefusal, renderError, renderReplayRun, renderAgentFeed, joinAgentFeed, explorerUrl, link, setQuoteUnit } from "../render.js";

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
  for (const f of ["app.js", "render.js", "replay.js", "theme.js", "setup.js", "setup-tx.js"]) {
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

test("explorer links: only base58 values, only devnet or mainnet, only explorer.solana.com, opened with noopener", () => {
  const sig = "5x".padEnd(88, "A");
  assert.equal(explorerUrl("tx", sig, "devnet"), `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  assert.equal(explorerUrl("tx", HOSTILE, "devnet"), null, "hostile value");
  assert.equal(explorerUrl("tx", "javascript:alert(1)", "devnet"), null);
  assert.equal(explorerUrl("tx", sig, "evil"), null, "unknown cluster");
  assert.equal(explorerUrl("script", sig, "devnet"), null, "unknown kind");
  assert.equal(explorerUrl("tx", sig, null), null, "local validator: no link");
  const bad = link(doc, "javascript:alert(1)", "x");
  assert.equal(bad.tag, "span", "a non-explorer url renders as text");
  const good = link(doc, explorerUrl("address", GUARD, "devnet"), "guard");
  assert.equal(good.tag, "a");
  assert.equal(good.rel, "noopener noreferrer");
  assert.equal(good.target, "_blank");
  const feed = new El("div");
  renderFeed(doc, feed, [{ slot: 1n, accepted: false, rule: 1, reason: 6000, direction: 0, size: 1n, reduceOnly: false, value: 1n, cap: 1n, signature: HOSTILE }], "devnet");
  const anchors = [];
  const walk = (e) => { if (e.tag === "a") anchors.push(e); (e.children ?? []).forEach(walk); };
  walk(feed);
  assert.equal(anchors.length, 0, "no link for a hostile signature");
});

test("the G10 meter's equity matches the guard's formula: deposits at cumulative interest plus base x oracle + quote", () => {
  const sm = new Uint8Array(800), smv = new DataView(sm.buffer);
  smv.setBigUint64(328, 10_000_000_000n, true); // cumulative deposit interest 1.0 (1e10)
  smv.setUint32(696, 6, true); // 6 decimals
  const or = new Uint8Array(48), ov = new DataView(or.buffer);
  ov.setBigInt64(8, 9_000_000_000n, true); // $90.00 at exponent -8
  ov.setInt32(32, -8, true);
  // 1,000 dUSDT deposited (scaled 1e9 = 1 token); 2 SOL long bought for 182 dUSDT
  const velocity = { positions: [{ marketIndex: 0, base: 2_000_000_000n, quote: -182_000_000n }], spot: [{ scaledBalance: 1_000_000_000_000n, marketIndex: 0, balanceType: 0 }], totalDeposits: 1_000_000_000n, totalWithdraws: 0n };
  const e = equityOf(velocity, sm, or);
  assert.equal(e.equity, 1_000_000_000n + 180_000_000n - 182_000_000n, "998 dUSDT");
  assert.equal(e.flows, 1_000_000_000n);
  assert.equal(equityOf({ ...velocity, positions: [{ marketIndex: 1, base: 1n, quote: 0n }] }, sm, or), null, "other markets are not priced");
});

test("the setup page: no HTML parsing, no inline or outside scripts, devnet or local RPC only, keys never stored", async () => {
  const { setupRpc } = await import("../setup-tx.js");
  for (const f of ["setup.js", "setup-tx.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/]) {
      assert.equal(bad.test(src), false, `${f} uses ${bad}`);
    }
  }
  const html = readFileSync(new URL("../setup.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][0], /src="\.\/setup\.js\?v=\d+"/);
  assert.equal(scripts[0][1].trim(), "", "no inline script");
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, "no inline event handlers");
  assert.equal(setupRpc(null), "https://api.devnet.solana.com");
  for (const bad of ["https://api.mainnet-beta.solana.com", "https://evil.example", "javascript:alert(1)", "https://u:p@api.devnet.solana.com", "https://api.devnet.solana.com:8443", "http://api.devnet.solana.com", HOSTILE]) {
    assert.equal(setupRpc(bad), null, bad);
  }
});

test("the quote unit follows spot market 0's mint: USDT for mainnet's USDT mint, dUSDT otherwise", () => {
  assert.equal(quoteUnitOf("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), "USDT");
  assert.equal(quoteUnitOf("GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6"), "dUSDT", "devnet faucet mint");
  for (const other of [EVIL, null, undefined, "", HOSTILE]) assert.equal(quoteUnitOf(other), "dUSDT");
  const refusal = { rule: 3, reason: 6007, value: 1_300_000_000n, cap: 1_200_000_000n, slot: 1n };
  try {
    setQuoteUnit("USDT");
    const last = new El("div");
    renderLastRefusal(doc, last, refusal);
    assert.ok(last.textContent.includes(" USDT traded today"), last.textContent);
    assert.ok(!last.textContent.includes("dUSDT"));
    setQuoteUnit(HOSTILE); // anything but the two known units is ignored
    const again = new El("div");
    renderLastRefusal(doc, again, refusal);
    assert.ok(again.textContent.includes(" USDT traded today") && !again.textContent.includes("<img"));
  } finally {
    setQuoteUnit("dUSDT");
  }
  const devnet = new El("div");
  renderLastRefusal(doc, devnet, refusal);
  assert.ok(devnet.textContent.includes(" dUSDT traded today"));
});
