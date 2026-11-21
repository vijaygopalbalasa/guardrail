// Dashboard rendering with DOM nodes and textContent only (no HTML parsing of any value from the RPC or a JSON file).
import { RULES, REASONS } from "./guard-view.js";

const num = (x) => Number(x);
const sol = (b) => (num(b) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
const usd = (b) => (num(b) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmt = (x, d = 2) => num(x).toLocaleString("en-US", { maximumFractionDigits: d });
const ORDER_TYPES = { 0: "market", 1: "limit", 2: "trigger market", 3: "trigger limit", 4: "oracle" };
const ruleName = (r) => RULES[r] ?? String(r);
const reasonName = (r) => REASONS[r] ?? String(r);
const SVG = "http://www.w3.org/2000/svg";

/** h(doc, "td", {className: "mono"}, "text", childNode, ...) */
export function h(doc, tag, props, ...children) {
  const el = doc.createElement(tag);
  if (props?.className) el.className = props.className;
  if (props?.width !== undefined) el.style.width = `${Math.max(0, Math.min(100, num(props.width)))}%`;
  if (props?.left !== undefined) el.style.left = `${Math.max(0, Math.min(100, num(props.left)))}%`;
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : doc.createTextNode(String(c)));
  }
  return el;
}

/** s(doc, "line", {x1: 0, ...}, children): an SVG element; attributes are numbers or fixed strings, text goes in as text nodes. */
function s(doc, tag, attrs, ...children) {
  const el = doc.createElementNS ? doc.createElementNS(SVG, tag) : doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (el.setAttribute) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : doc.createTextNode(String(c)));
  }
  return el;
}

/** A rule's measured value against its cap, in the rule's units. */
export function measure(rule, v, cap, reason) {
  if (rule === 2) {
    if (reason === 6001) return `market ${num(v)} is not on the allowlist`;
    if (reason === 6002) return `${ORDER_TYPES[num(v)] ?? num(v)} orders are not allowed`;
    if (reason === 6003) return "builder fields must be empty";
    if (reason === 6015) return "trigger orders are not supported";
    if (reason === 6030) return `max_ts not in the future or more than ${num(cap)} s away`;
    if (reason === 6031) return `${num(cap)} guard orders already open; cancel one first`;
    return "order shape not allowed";
  }
  if (rule === 6 && reason === 6028) return `exit with an oracle ${num(v)} slots old (over ${num(cap)}) priced against the owner`;
  if (rule === 5 && reason === 6022) return "a non-quote spot balance or quote borrow exists";
  if (rule === 5 && reason === 6024) return "account equity is not positive";
  switch (rule) {
    case 1: return `${sol(v)} SOL in one order, limit ${sol(cap)} SOL`;
    case 4: return `${sol(v)} SOL at risk on this market, cap ${sol(cap)} SOL`;
    case 3: return `${usd(v)} dUSDT traded today, cap ${usd(cap)}`;
    case 5: return `worst-case leverage ${(num(v) / 1e4).toFixed(2)}x, cap ${(num(cap) / 1e4).toFixed(2)}x`;
    case 6: return `${(num(v) / 100).toFixed(2)}% from the oracle, band ${(num(cap) / 100).toFixed(2)}%`;
    case 7: return "the owner paused the guard";
    case 10: return `${usd(v)} dUSDT lost today, cap ${usd(cap)}`;
    default: return "";
  }
}

const chip = (doc, kind, text) => h(doc, "span", { className: `chip ${kind}` }, text);

export function renderError(doc, box, message) {
  box.replaceChildren(h(doc, "p", { className: "err" }, String(message)));
}

export function renderBars(doc, box, refused) {
  const names = { G1: "G1 order size", G2: "G2 allowlist", G3: "G3 daily notional", G4: "G4 exposure", G5: "G5 leverage", G6: "G6 price band", G7: "G7 paused", G10: "G10 daily loss" };
  const max = Math.max(1, ...Object.values(refused).map(num));
  box.replaceChildren(...Object.entries(refused).map(([k, n]) =>
    h(doc, "div", { className: `bar${num(n) ? "" : " off"}` },
      h(doc, "span", null, names[k] ?? k),
      h(doc, "div", { className: "track" }, h(doc, "div", { className: "base" }), h(doc, "div", { className: `fill${num(n) ? "" : " zero"}`, width: (num(n) / max) * 100 })),
      h(doc, "span", { className: "n" }, String(num(n))))));
}

export function renderLastRefusal(doc, box, lr) {
  if (!lr.reason) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No refusals yet.")); return; }
  const kv = [["Rule", ruleName(lr.rule)], ["Why", measure(lr.rule, lr.value, lr.cap, lr.reason)], ["Error name", reasonName(lr.reason)], ["Slot", String(lr.slot)]];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

export function renderVelocity(doc, box, velocity) {
  const rows = [];
  if (velocity.positions.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["Position", "Size", "Open bids", "Open asks"].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.positions.map((p) => h(doc, "tr", null,
      h(doc, "td", null, `market ${num(p.marketIndex)}`), h(doc, "td", null, `${sol(p.base)} SOL`), h(doc, "td", null, `${sol(p.openBids)} SOL`), h(doc, "td", null, `${sol(Math.abs(num(p.openAsks)))} SOL`)))));
  }
  if (velocity.orders.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["Open order", "Size", "Price", "Filled"].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.orders.map((o) => h(doc, "tr", null,
      h(doc, "td", null, `#${num(o.orderId)} ${o.side === "long" ? "buy" : "sell"}`), h(doc, "td", null, `${sol(o.size)} SOL`), h(doc, "td", null, `$${usd(o.price)}`), h(doc, "td", null, `${sol(o.filled)} SOL`)))));
  }
  box.replaceChildren(rows.length ? h(doc, "table", null, rows) : h(doc, "p", { className: "empty" }, "No positions or open orders."));
}

export function renderFeed(doc, box, decisions) {
  if (!decisions.length) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No orders yet. Orders the agent sends through the guard appear here.")); return; }
  const head = h(doc, "thead", null, h(doc, "tr", null, ["Slot", "Verdict", "Order", "Why"].map((t) => h(doc, "th", null, t))));
  const body = h(doc, "tbody", null, decisions.map((d) => {
    const why = d.accepted ? (d.rule === 9 ? "an exit inside the band" : "inside every limit") : measure(d.rule, d.value, d.cap, d.reason);
    return h(doc, "tr", null,
      h(doc, "td", null, String(d.slot)),
      h(doc, "td", null, d.accepted ? chip(doc, "ok", "Accepted") : chip(doc, "no", `Refused by ${ruleName(d.rule)}`)),
      h(doc, "td", null, `${num(d.direction) === 0 ? "buy" : "sell"} ${sol(d.size)} SOL${d.reduceOnly ? " (exit)" : ""}`),
      h(doc, "td", null, why, d.reason ? h(doc, "div", { className: "addr" }, reasonName(d.reason)) : null));
  }));
  box.replaceChildren(h(doc, "table", null, head, body));
}

export function renderLimits(doc, box, g) {
  const l = g.limits;
  const types = [["market", 1], ["limit", 2], ["oracle", 16]].filter(([, b]) => num(l.allowedOrderTypes) & b).map(([n]) => n).join(", ");
  const markets = l.markets.filter((m, i) => i === 0 || num(m.maxExposureBase) > 0);
  const kv = [
    ["G1 per order", `${sol(l.maxOrderBase)} SOL`],
    ["G2 markets", markets.map((m) => num(m.marketIndex)).join(", ") || "none"],
    ["G2 order types", types],
    ["G3 per UTC day", `${usd(l.dailyNotionalCap)} dUSDT, ${usd(g.dayNotional)} used`],
    ...markets.map((m) => [`G4 market ${num(m.marketIndex)}`, `${sol(m.maxExposureBase)} SOL worst case`]),
    ["G5 leverage", `${(num(l.maxLeverageBps) / 1e4).toFixed(2)}x worst case`],
    ["G6 price band", `${(num(l.priceBandBps) / 100).toFixed(2)}% of the oracle`],
    ...(g.dailyLoss ? [["G10 daily loss", num(g.dailyLoss.max) ? `${usd(g.dailyLoss.max)} dUSDT a UTC day` : "off"]] : []),
    ["G9 exits", "always allowed inside the band"],
    ["Withdraw", "impossible for the agent"],
  ];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

/* ---------- The language-model agent's own words next to the chain's verdicts ---------- */

const cleanReason = (r) => String(r ?? "").replace(/^Reason:\s*/i, "").replace(/\*\*|`/g, "").split(/\s-\s|\n-/)[0].replace(/\s+/g, " ").trim().replace(/:$/, ".").slice(0, 260);

function agentAction(t) {
  const a = t.args ?? {};
  if (t.tool === "guardrail_place_order") return `asked to ${a.side === "short" ? "sell" : "buy"} ${fmt(a.size, 4)} SOL${a.price ? ` at $${fmt(a.price)}` : ""}${a.reduce_only ? " (exit)" : ""}`;
  if (t.tool === "guardrail_cancel_order") return "cancelled one of its orders";
  if (t.tool === "guardrail_status") return "read its limits and open orders";
  return "placed nothing";
}

/** Pairs each place_order turn with the guard's on-chain decision, oldest first, when the counts and verdicts agree. */
export function joinAgentFeed(turns, decisions) {
  const placed = turns.filter((t) => t.tool === "guardrail_place_order" && typeof t.accepted === "boolean");
  const chain = [...decisions].sort((a, b) => num(a.slot) - num(b.slot));
  if (!placed.length || placed.length !== chain.length) return null;
  if (placed.some((t, i) => t.accepted !== chain[i].accepted)) return null;
  return new Map(placed.map((t, i) => [t, chain[i]]));
}

export function renderAgentFeed(doc, box, feed, decisions) {
  const turns = Array.isArray(feed?.turns) ? feed.turns : [];
  if (!turns.length) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No agent run recorded.")); return null; }
  const joined = decisions ? joinAgentFeed(turns, decisions) : null;
  box.replaceChildren(...turns.map((t) => {
    const d = joined?.get(t);
    let verdict;
    if (t.tool === "guardrail_place_order") verdict = t.accepted === true ? chip(doc, "ok", "Accepted on chain") : t.accepted === false ? chip(doc, "no", `Refused by ${String(t.rule)}`) : chip(doc, "info", "Error");
    else verdict = chip(doc, "info", t.tool ? "Read only" : "No order");
    return h(doc, "li", null,
      h(doc, "span", { className: "turn" }, String(num(t.turn))),
      h(doc, "div", null,
        h(doc, "div", { className: "said" }, cleanReason(t.reason) || "(no reason given)"),
        h(doc, "div", { className: "did" }, verdict, h(doc, "span", null, agentAction(t)), d ? h(doc, "span", { className: "addr" }, `slot ${String(d.slot)}`) : null,
          d && !d.accepted ? h(doc, "span", null, measure(d.rule, d.value, d.cap, d.reason)) : null)));
  }));
  return joined;
}

/* ---------- Replay: price line, position against the cap, refusal markers ---------- */

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** The position cap a run's G4 refusals report, in SOL (null when G4 never bound). */
export function runCap(run) {
  for (const st of run.steps) for (const d of st.decisions ?? []) if (d.rule === 4 && d.cap) return num(d.cap) / 1e9;
  return null;
}

/** What stops a run that has no position cap: the first limit that refused it, in words. */
function bindingNote(run) {
  for (const st of run.steps) for (const d of st.decisions ?? []) {
    if (d.rule === 5) return `leverage cap ${(num(d.cap) / 1e4).toFixed(1)}x binds`;
    if (d.rule === 3) return `daily cap ${usd(d.cap)} dUSDT binds`;
  }
  return run.id === "unguarded" ? "no cap, only Velocity's 5x margin check" : "no position cap";
}

const refusalsAt = (st) => (st.decisions ?? []).filter((d) => d.result !== "accepted");

/** One plain sentence for one decision of the replay. */
export function plainDecision(d) {
  const size = `${fmt(d.size, 4)} SOL`;
  if (d.result === "accepted") return { kind: "ok", tag: "Accepted", text: `buy ${size}, ${fmt(d.filled, 4)} SOL filled` };
  if (d.result === "velocity") return { kind: "info", tag: "Velocity refused", text: `buy ${size}: not enough margin under Velocity's own 5x check` };
  const rule = num(d.rule);
  const why = {
    1: () => `more than ${sol(d.cap)} SOL in one order`,
    3: () => `would take today's traded amount to ${usd(d.value)} dUSDT, cap ${usd(d.cap)}`,
    4: () => `would put ${sol(d.value)} SOL at risk, cap ${sol(d.cap)} SOL`,
    5: () => `would lift worst-case leverage to ${(num(d.value) / 1e4).toFixed(2)}x, cap ${(num(d.cap) / 1e4).toFixed(2)}x`,
    6: () => `price too far from the oracle`,
    10: () => `today's loss is ${usd(d.value)} dUSDT, over the ${usd(d.cap)} daily loss cap`,
  }[rule];
  return { kind: "no", tag: `Refused by ${String(d.by ?? `G${rule}`)}`, text: `buy ${size}: ${why ? why() : "over a limit"}` };
}

/** Geometry shared by the price and position charts. */
function frame(width, height, n) {
  const L = 40, R = 76, T = 22, B = 24;
  const pw = Math.max(40, width - L - R), ph = height - T - B;
  return { L, R, T, B, pw, ph, width, height, x: (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * pw) };
}

/** The SOL price over the replay; the part already played is drawn solid, the rest faint. */
export function renderPriceChart(doc, box, run, i, width = 640) {
  const st = run.steps, n = st.length;
  const prices = st.map((x) => num(x.price));
  const lo = Math.floor(Math.min(...prices) - 1), hi = Math.ceil(Math.max(...prices) + 1);
  const f = frame(width, 150, n);
  const y = (p) => f.T + (1 - (p - lo) / (hi - lo)) * f.ph;
  const path = (k) => prices.slice(0, k + 1).map((p, j) => `${j ? "L" : "M"}${f.x(j).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const svg = s(doc, "svg", { viewBox: `0 0 ${width} ${f.height}`, height: f.height, role: "img", "aria-label": `SOL price, $${prices[0].toFixed(2)} falling to $${prices[n - 1].toFixed(2)}; now $${prices[i].toFixed(2)}` },
    ticks.map((t) => [s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(t), y2: y(t), stroke: "var(--grid)", "stroke-width": 1 }),
      s(doc, "text", { x: f.L - 8, y: y(t) + 4, "text-anchor": "end" }, `$${t}`)]),
    s(doc, "path", { d: path(n - 1), fill: "none", stroke: "var(--axis)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s(doc, "path", { d: path(i), fill: "none", stroke: "var(--ink)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s(doc, "line", { x1: f.x(i), x2: f.x(i), y1: f.T - 6, y2: f.T + f.ph, stroke: "var(--axis)", "stroke-width": 1 }),
    s(doc, "circle", { cx: f.x(i), cy: y(prices[i]), r: 4.5, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }),
    s(doc, "text", { x: f.x(i) + 10, y: y(prices[i]) - 8, class: "mark-label" }, `$${prices[i].toFixed(2)}`),
    s(doc, "text", { x: f.L, y: f.height - 4 }, "step 1"),
    s(doc, "text", { x: f.L + f.pw, y: f.height - 4, "text-anchor": "end" }, st[n - 1].final ? "final mark" : `step ${n}`));
  box.replaceChildren(svg, h(doc, "div", { className: "tip" }));
  return { ...f, n, tip: (j) => `${st[j].final ? "final mark" : `step ${j + 1}`}: SOL $${prices[j].toFixed(2)}` };
}

/** Position over the replay with the G4 cap line and a tick for every step that had refusals. */
export function renderPositionChart(doc, box, run, i, { maxY, width = 520, key = "gu" } = {}) {
  const st = run.steps, n = st.length;
  const cap = runCap(run);
  const top = maxY ?? niceMax(Math.max(...st.map((x) => num(x.position) + num(x.openBids)), cap ?? 0));
  const f = frame(width, 200, n);
  const y = (v) => f.T + (1 - Math.min(v, top) / top) * f.ph;
  const pts = st.slice(0, i + 1).map((x, j) => [f.x(j), y(num(x.position))]);
  const line = pts.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)} L${f.x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ticks = [0, top / 2, top];
  const marks = st.slice(0, i + 1).map((x, j) => [j, refusalsAt(x).length]).filter(([, k]) => k > 0);
  const now = refusalsAt(st[i]).length;
  const svg = s(doc, "svg", { viewBox: `0 0 ${width} ${f.height}`, height: f.height, role: "img", "aria-label": `${String(run.title)}: position ${fmt(st[i].position, 3)} SOL at step ${i + 1}${cap ? `, cap ${cap} SOL` : ""}` },
    ticks.map((t) => [s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }),
      s(doc, "text", { x: f.L - 8, y: y(t) + 4, "text-anchor": "end" }, `${fmt(t, 1)}`)]),
    s(doc, "text", { x: f.L - 8, y: f.T - 10, "text-anchor": "end" }, "SOL"),
    s(doc, "path", { d: area, fill: `var(--${key}-wash)`, stroke: "none" }),
    cap !== null && cap <= top ? [
      s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(cap), y2: y(cap), stroke: "var(--cap)", "stroke-width": 2 }),
      s(doc, "text", { x: f.L + f.pw + 8, y: y(cap) + 4, class: "cap-label" }, `cap ${fmt(cap)} SOL`)] : null,
    s(doc, "path", { d: line, fill: "none", stroke: `var(--${key})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    marks.map(([j, k]) => s(doc, "line", { x1: f.x(j), x2: f.x(j), y1: 2, y2: 4 + Math.min(14, 4 + k * 1.2), stroke: "var(--ink-2)", "stroke-width": 2, "stroke-linecap": "round" })),
    now ? s(doc, "text", { x: Math.min(f.x(i) + 6, f.L + f.pw + 4), y: 14, class: "mark-label" }, `${now} refused`) : null,
    s(doc, "circle", { cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: 4.5, fill: `var(--${key})`, stroke: "var(--surface)", "stroke-width": 2 }),
    (() => {
      const [px, py] = pts[pts.length - 1];
      const nearEnd = px > f.L + f.pw * 0.72;
      return s(doc, "text", { x: nearEnd ? px - 8 : px + 8, y: Math.max(f.T + 12, py - 10), "text-anchor": nearEnd ? "end" : "start", class: "mark-label" }, `${fmt(st[i].position, 2)} SOL`);
    })(),
    s(doc, "text", { x: f.L, y: f.height - 4 }, "step 1"),
    s(doc, "text", { x: f.L + f.pw, y: f.height - 4, "text-anchor": "end" }, st[n - 1].final ? "final mark" : `step ${n}`));
  box.replaceChildren(svg, h(doc, "div", { className: "tip" }));
  return { ...f, n, tip: (j) => `${st[j].final ? "final mark" : `step ${j + 1}`}: ${fmt(st[j].position, 3)} SOL held, ${fmt(st[j].lossPct, 1)}% lost, ${refusalsAt(st[j]).length} refused` };
}

/** One run of the replay at one step: loss so far, the position chart, a position bar against the cap, the step in words. */
export function renderReplayRun(doc, box, run, i, collateral, opts = {}) {
  const st = run.steps[Math.min(i, run.steps.length - 1)];
  const key = opts.key ?? (run.id === "unguarded" ? "un" : "gu");
  const lossPct = Math.max(0, num(st.lossPct));
  const worst = Math.max(0, ...run.steps.slice(0, i + 1).map((x) => num(x.lossPct)));
  const cap = runCap(run);
  const top = opts.maxY ?? niceMax(Math.max(...run.steps.map((x) => num(x.position)), cap ?? 0));
  const held = num(st.position) + num(st.openBids);
  const chartBox = h(doc, "div", { className: "chart" });
  const decisions = (st.decisions ?? []).map(plainDecision);
  const refusedSoFar = run.steps.slice(0, i + 1).reduce((a, x) => a + refusalsAt(x).length, 0);
  const capEl = cap !== null && cap <= top
    ? [h(doc, "div", { className: "capline", left: (cap / top) * 100 }), h(doc, "div", { className: "caplabel", left: (cap / top) * 100 }, `cap ${fmt(cap)}`)]
    : null;
  box.replaceChildren(
    h(doc, "div", { className: "run-head" }, h(doc, "span", { className: `key ${key}` }), h(doc, "span", { className: "run-title" }, String(run.title))),
    h(doc, "div", { className: "run-limits" }, `Limits: ${String(run.limits)}`),
    h(doc, "div", { className: "run-figs" },
      h(doc, "div", null, h(doc, "div", { className: "figure" }, lossPct < 0.05 ? "0.0%" : `-${lossPct.toFixed(1)}%`), h(doc, "div", { className: "figure-label" }, `equity lost so far (worst ${worst.toFixed(1)}%)`)),
      h(doc, "div", null, h(doc, "div", { className: "figure" }, String(refusedSoFar)), h(doc, "div", { className: "figure-label" }, key === "un" ? "orders Velocity refused" : "orders Guardrail refused"))),
    chartBox,
    h(doc, "div", { className: "posbar", role: "img" },
      h(doc, "div", { className: "base" }),
      h(doc, "div", { className: `fill ${key}`, width: (Math.min(held, top) / top) * 100 }),
      capEl),
    h(doc, "div", { className: "posbar-legend" },
      h(doc, "span", null, `${fmt(st.position, 3)} SOL held${num(st.openBids) ? ` + ${fmt(st.openBids, 3)} bid` : ""} at ${fmt(st.leverage)}x`),
      h(doc, "span", null, cap !== null ? `${fmt(Math.max(0, cap - held), 3)} SOL of room` : bindingNote(run))),
    h(doc, "div", { className: "wants" }, st.final
      ? `Final mark: SOL moves 1% more to $${num(st.price).toFixed(2)} with no new orders. The worst loss is measured here.`
      : `Step ${num(st.step) + 1}: the agent wants +${fmt(st.wants, 4)} SOL at $${num(st.price).toFixed(2)}`),
    h(doc, "ul", { className: "steplog" }, decisions.length
      ? decisions.map((d) => h(doc, "li", null, h(doc, "span", { className: `chip ${d.kind}` }, d.tag), h(doc, "span", null, d.text)))
      : [h(doc, "li", null, h(doc, "span", { className: "chip info" }, "No orders"), h(doc, "span", null, st.final ? "the replay ends; positions are marked at this price" : "no order this step"))]),
  );
  const chart = renderPositionChart(doc, chartBox, run, i, { maxY: top, width: opts.width ?? 520, key });
  return { chartBox, chart };
}
