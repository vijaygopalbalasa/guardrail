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
    if (reason === 6034) return `reduce-only beyond the ${sol(cap)} SOL position`;
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
const MARKETS = { 0: "SOL-PERP" };
export const marketName = (i) => MARKETS[num(i)] ?? `market ${num(i)}`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
/** An explorer link for a transaction or an account, only for base58 values and the devnet or mainnet cluster. */
export function explorerUrl(kind, value, cluster) {
  if (!B58.test(String(value)) || (kind !== "tx" && kind !== "address")) return null;
  if (cluster === "devnet") return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
  if (cluster === "mainnet") return `https://explorer.solana.com/${kind}/${value}`;
  return null;
}
/** An <a> to the explorer opened in a new tab (DOM APIs only), or plain text when no safe link exists. */
export function link(doc, url, text, className) {
  if (!url || !url.startsWith("https://explorer.solana.com/")) return h(doc, "span", { className }, text);
  const a = h(doc, "a", { className }, text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
const ago = (t, now) => {
  if (!t) return "";
  const s = Math.max(0, Math.round(now - num(t)));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
export { ago };

export function renderError(doc, box, message) {
  box.replaceChildren(h(doc, "p", { className: "err" }, String(message)));
}

/** "2 refused: G1 order size 1, G4 exposure 1. 0 for the rest." Only the rules that fired. */
export function renderRefusals(doc, box, refused) {
  const names = { G1: "G1 order size", G2: "G2 allowlist", G3: "G3 daily notional", G4: "G4 exposure", G5: "G5 leverage", G6: "G6 price band", G7: "G7 paused", G10: "G10 daily loss" };
  const fired = Object.entries(refused).filter(([, n]) => num(n) > 0);
  const total = fired.reduce((a, [, n]) => a + num(n), 0);
  if (!total) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No refusals yet.")); return; }
  box.replaceChildren(h(doc, "ul", { className: "fired" }, fired.map(([k, n]) => h(doc, "li", null, chip(doc, "no", names[k] ?? k), h(doc, "span", { className: "n" }, String(num(n)))))),
    h(doc, "p", { className: "note" }, fired.length < Object.keys(refused).length ? "0 for every other rule." : ""));
}

/** How close each limit is to binding now: a meter per limit, filled toward the cap. */
export function renderHeadroom(doc, box, g, velocity, decisions, nowSec) {
  const l = g.limits;
  const rows = [];
  const meter = (name, used, cap, text) => {
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    rows.push(h(doc, "div", { className: `meter${pct >= 99.9 ? " full" : ""}` },
      h(doc, "div", { className: "meter-top" }, h(doc, "span", null, name), h(doc, "span", { className: "meter-n" }, text)),
      h(doc, "div", { className: "meter-track" }, h(doc, "div", { className: "meter-fill", width: pct }))));
  };
  const today = Math.floor(num(nowSec) / 86400);
  const used = num(g.day) === today ? num(g.dayNotional) : 0;
  meter("G3 traded today", used, num(l.dailyNotionalCap), `${usd(used)} of ${usd(l.dailyNotionalCap)} dUSDT`);
  for (const m of l.markets.filter((x) => num(x.maxExposureBase) > 0)) {
    const p = velocity.positions.find((x) => num(x.marketIndex) === num(m.marketIndex));
    const w = p ? Math.max(Math.abs(num(p.base) + num(p.openBids)), Math.abs(num(p.base) - Math.abs(num(p.openAsks)))) : 0;
    meter(`G4 ${marketName(m.marketIndex)} worst case`, w, num(m.maxExposureBase), `${sol(w)} of ${sol(m.maxExposureBase)} SOL${w >= num(m.maxExposureBase) ? ", at the cap" : ""}`);
  }
  const lastAcc = decisions.find((d) => d.accepted && d.rule === 0);
  if (lastAcc) meter("G5 leverage at the last accepted order", num(lastAcc.value), num(l.maxLeverageBps), `${(num(lastAcc.value) / 1e4).toFixed(2)}x of ${(num(l.maxLeverageBps) / 1e4).toFixed(2)}x`);
  const biggest = Math.max(0, ...decisions.filter((d) => d.accepted).map((d) => num(d.size)));
  meter("G1 largest accepted order", biggest, num(l.maxOrderBase), `${sol(biggest)} of ${sol(l.maxOrderBase)} SOL`);
  if (g.dailyLoss && num(g.dailyLoss.max) && (!g.dailyLoss.keeper || g.dailyLoss.keeper === "11111111111111111111111111111111")) {
    rows.push(h(doc, "p", { className: "warn" }, "No keeper set: G10 needs one to mark each UTC day at midnight. The owner names one with set_keeper."));
  }
  if (g.dailyLoss && num(g.dailyLoss.max)) {
    const dl = g.dailyLoss, eq = velocity.equity;
    if (eq && num(dl.day) === today && num(dl.baselineEquity) !== 0) {
      const lost = Math.max(0, num(dl.baselineEquity) + (num(eq.flows) - num(dl.baselineFlows)) - num(eq.equity));
      meter("G10 lost today", lost, num(dl.max), `${usd(lost)} of ${usd(dl.max)} dUSDT`);
    } else {
      rows.push(h(doc, "p", { className: "note" }, `G10 daily loss cap ${usd(dl.max)} dUSDT. ${num(dl.day) === today ? "" : "No guard call yet today: "}the day's baseline is taken at the guard's first call that UTC day.`));
    }
  }
  box.replaceChildren(...rows);
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

export function renderLastRefusal(doc, box, lr, decisions, cluster) {
  if (!lr.reason) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No refusals yet.")); return; }
  const d = (decisions ?? []).find((x) => !x.accepted && String(x.slot) === String(lr.slot));
  const kv = [["Rule", ruleName(lr.rule)], ["Why", measure(lr.rule, lr.value, lr.cap, lr.reason)], ["Error name", reasonName(lr.reason)], ["Transaction", link(doc, d ? explorerUrl("tx", d.signature, cluster) : null, `slot ${String(lr.slot)}`, "tx")]];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

export function renderVelocity(doc, box, velocity) {
  const rows = [];
  if (velocity.positions.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["Position", "Size", "Open bids", "Open asks"].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.positions.map((p) => h(doc, "tr", null,
      h(doc, "td", null, marketName(p.marketIndex)), h(doc, "td", null, `${sol(p.base)} SOL`), h(doc, "td", null, `${sol(p.openBids)} SOL`), h(doc, "td", null, `${sol(Math.abs(num(p.openAsks)))} SOL`)))));
  }
  if (velocity.orders.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["Open order", "Size", "Price", "Filled"].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.orders.map((o) => h(doc, "tr", null,
      h(doc, "td", null, `#${num(o.orderId)} ${o.side === "long" ? "buy" : "sell"}`), h(doc, "td", null, `${sol(o.size)} SOL`), h(doc, "td", null, `$${usd(o.price)}`), h(doc, "td", null, `${sol(o.filled)} SOL`)))));
  }
  box.replaceChildren(rows.length ? h(doc, "table", null, rows) : h(doc, "p", { className: "empty" }, "No positions or open orders."));
}

export function renderFeed(doc, box, decisions, cluster, nowSec) {
  if (!decisions.length) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No orders yet. Orders the agent sends through the guard appear here.")); return; }
  const head = h(doc, "thead", null, h(doc, "tr", null, ["Verdict", "Order", "Why", "Transaction"].map((t) => h(doc, "th", null, t))));
  const body = h(doc, "tbody", null, decisions.map((d) => {
    const why = d.accepted ? (d.rule === 9 ? "an exit inside the band" : "inside every limit") : measure(d.rule, d.value, d.cap, d.reason);
    const when = nowSec && d.blockTime ? `, ${ago(d.blockTime, nowSec)}` : "";
    return h(doc, "tr", null,
      h(doc, "td", { className: "c-verdict" }, d.accepted ? chip(doc, "ok", "Accepted") : chip(doc, "no", `Refused by ${ruleName(d.rule)}`)),
      h(doc, "td", { className: "c-order" }, `${num(d.direction) === 0 ? "buy" : "sell"} ${sol(d.size)} SOL ${marketName(d.marketIndex ?? 0)}${d.reduceOnly ? " (exit)" : ""}`),
      h(doc, "td", { className: "c-why" }, why, d.reason ? h(doc, "div", { className: "addr" }, reasonName(d.reason)) : null),
      h(doc, "td", { className: "c-tx" }, link(doc, explorerUrl("tx", d.signature, cluster), `slot ${String(d.slot)}`, "tx"), when));
  }));
  box.replaceChildren(h(doc, "table", { className: "orders" }, head, body));
}

export function renderLimits(doc, box, g) {
  const l = g.limits;
  const types = [["market", 1], ["limit", 2], ["oracle", 16]].filter(([, b]) => num(l.allowedOrderTypes) & b).map(([n]) => n).join(", ");
  const markets = l.markets.filter((m, i) => i === 0 || num(m.maxExposureBase) > 0);
  const kv = [
    ["G1 per order", `${sol(l.maxOrderBase)} SOL`],
    ["G2 markets", markets.map((m) => marketName(m.marketIndex)).join(", ") || "none"],
    ["G2 order types", types],
    ["G3 per UTC day", `${usd(l.dailyNotionalCap)} dUSDT, ${usd(g.dayNotional)} used`],
    ...markets.map((m) => [`G4 ${marketName(m.marketIndex)}`, `${sol(m.maxExposureBase)} SOL worst case`]),
    ["G5 leverage", `${(num(l.maxLeverageBps) / 1e4).toFixed(2)}x worst case`],
    ["G6 price band", `${(num(l.priceBandBps) / 100).toFixed(2)}% of the oracle`],
    ...(g.dailyLoss ? [["G10 daily loss", num(g.dailyLoss.max) ? `${usd(g.dailyLoss.max)} dUSDT a UTC day` : "off"]] : []),
    ["G9 exits", "always allowed inside the band"],
    ["Withdraw", "impossible for the agent"],
  ];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

/* ---------- The language-model agent's own words next to the chain's verdicts ---------- */

const cleanReason = (r) => String(r ?? "").replace(/^Reason:\s*/i, "").replace(/\*\*|`/g, "").split(/\s-\s|\n-/)[0].replace(/\s+/g, " ").trim().replace(/:$/, ".");
const clip = (t, n = 260) => (t.length <= n ? t : `${t.slice(0, t.lastIndexOf(" ", n))}...`);

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

export function renderAgentFeed(doc, box, feed, decisions, cluster) {
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
        h(doc, "div", { className: "said" }, clip(cleanReason(t.reason)) || "(no reason given)"),
        h(doc, "div", { className: "did" }, verdict, h(doc, "span", null, agentAction(t)), d ? link(doc, explorerUrl("tx", d.signature, cluster), `slot ${String(d.slot)}`, "tx") : null,
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
    if (d.rule === 5) return `Binding limit: G5 leverage cap ${(num(d.cap) / 1e4).toFixed(1)}x.`;
    if (d.rule === 3) return `Binding limit: G3 daily notional cap ${usd(d.cap)} dUSDT.`;
    if (d.rule === 10) return `Binding limit: G10 daily loss cap ${usd(d.cap)} dUSDT.`;
  }
  return run.id === "unguarded" ? "No cap: only Velocity's own 5x margin check." : "No position cap.";
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

/** Geometry shared by the replay charts. */
function frame(width, height, n, R = 84) {
  const L = 40, T = 24, B = 26;
  const pw = Math.max(40, width - L - R), ph = height - T - B;
  return { L, R, T, B, pw, ph, width, height, x: (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * pw) };
}

/** Step ticks on the x axis: every step a short tick, labels thinned to fit, the last one named. */
function xAxis(doc, f, st) {
  const n = st.length;
  const every = f.pw / n < 26 ? Math.ceil(26 / (f.pw / n)) : 1;
  const y0 = f.T + f.ph;
  return st.map((x, j) => [
    s(doc, "line", { x1: f.x(j), x2: f.x(j), y1: y0, y2: y0 + 4, stroke: "var(--axis)", "stroke-width": 1 }),
    j === n - 1 ? s(doc, "text", { x: f.x(j), y: f.height - 4, "text-anchor": "end" }, x.final ? "final" : String(j + 1))
      : j % every === 0 && f.x(n - 1) - f.x(j) >= 34 ? s(doc, "text", { x: f.x(j), y: f.height - 4, "text-anchor": "middle" }, String(j + 1)) : null,
  ]);
}
const stepName = (st, j) => (st[j].final ? "final mark" : `step ${j + 1}`);

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
    xAxis(doc, f, st),
    s(doc, "path", { d: path(n - 1), fill: "none", stroke: "var(--axis)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s(doc, "path", { d: path(i), fill: "none", stroke: "var(--ink)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s(doc, "line", { x1: f.x(i), x2: f.x(i), y1: f.T - 6, y2: f.T + f.ph, stroke: "var(--axis)", "stroke-width": 1 }),
    s(doc, "circle", { cx: f.x(i), cy: y(prices[i]), r: 4.5, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }),
    s(doc, "text", { x: f.x(i) + 10, y: y(prices[i]) - 8, class: "mark-label" }, `$${prices[i].toFixed(2)}`));
  box.replaceChildren(svg, h(doc, "div", { className: "tip" }));
  return { ...f, n, tip: (j) => `${stepName(st, j)}: SOL $${prices[j].toFixed(2)}` };
}

/** Equity lost (% of the starting collateral) for both runs on one axis, drawn up to the current step. */
export function renderLossChart(doc, box, runs, i, width = 640) {
  const st = runs[0].steps, n = st.length;
  const loss = (r, j) => Math.max(0, num(r.steps[Math.min(j, r.steps.length - 1)].lossPct));
  const top = niceMax(Math.max(...runs.flatMap((r) => r.steps.map((_, j) => loss(r, j)))));
  const f = frame(width, 190, n, 128);
  const y = (v) => f.T + (v / top) * f.ph; // 0% at the top, losses grow downward
  const keys = ["un", "gu"];
  const ticks = [0, top / 2, top];
  const lines = runs.map((r, k) => {
    const pts = r.steps.slice(0, i + 1).map((_, j) => [f.x(j), y(loss(r, j))]);
    const d = pts.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const [ex, ey] = pts[pts.length - 1];
    return [
      s(doc, "path", { d, fill: "none", stroke: `var(--${keys[k]})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
      s(doc, "circle", { cx: ex, cy: ey, r: 4.5, fill: `var(--${keys[k]})`, stroke: "var(--surface)", "stroke-width": 2 }),
      { ey, text: `-${loss(r, i).toFixed(1)}% ${k === 0 ? "unguarded" : "guarded"}` },
    ];
  });
  // End labels beside the right edge, nudged apart when they would touch.
  const [a, b] = [lines[0][2], lines[1][2]];
  let ya = a.ey + 4, yb = b.ey + 4;
  if (Math.abs(ya - yb) < 14) { if (ya <= yb) yb = ya + 14; else ya = yb + 14; }
  const lx = f.x(i) + 8;
  const svg = s(doc, "svg", { viewBox: `0 0 ${width} ${f.height}`, height: f.height, role: "img", "aria-label": `Equity lost: ${a.text}, ${b.text} at ${stepName(st, i)}` },
    ticks.map((t) => [s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }),
      s(doc, "text", { x: f.L - 8, y: y(t) + 4, "text-anchor": "end" }, `${t === 0 ? "" : "-"}${fmt(t, 0)}%`)]),
    xAxis(doc, f, st),
    s(doc, "line", { x1: f.x(i), x2: f.x(i), y1: f.T - 6, y2: f.T + f.ph, stroke: "var(--axis)", "stroke-width": 1 }),
    lines.map((l) => l.slice(0, 2)),
    s(doc, "text", { x: lx, y: ya, class: "mark-label" }, a.text),
    s(doc, "text", { x: lx, y: yb, class: "mark-label" }, b.text));
  box.replaceChildren(svg, h(doc, "div", { className: "tip" }));
  return { ...f, n, tip: (j) => `${stepName(st, j)}: unguarded -${loss(runs[0], j).toFixed(1)}%, guarded -${loss(runs[1], j).toFixed(1)}%` };
}

/** Position over the replay with the G4 cap as a dashed line and a tick for every step that had refused orders. */
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
  const [px, py] = pts[pts.length - 1];
  const nearEnd = px > f.L + f.pw * 0.72;
  const svg = s(doc, "svg", { viewBox: `0 0 ${width} ${f.height}`, height: f.height, role: "img", "aria-label": `${String(run.title)}: position ${fmt(st[i].position, 3)} SOL at ${stepName(st, i)}${cap ? `, cap ${cap} SOL` : ""}` },
    ticks.map((t) => [s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }),
      s(doc, "text", { x: f.L - 8, y: y(t) + 4, "text-anchor": "end" }, `${fmt(t, 1)}`)]),
    s(doc, "text", { x: f.L - 8, y: f.T - 10, "text-anchor": "end" }, "SOL"),
    xAxis(doc, f, st),
    s(doc, "path", { d: area, fill: `var(--${key}-wash)`, stroke: "none" }),
    cap !== null && cap <= top ? [
      s(doc, "line", { x1: f.L, x2: f.L + f.pw, y1: y(cap), y2: y(cap), stroke: "var(--cap)", "stroke-width": 2, "stroke-dasharray": "6 4" }),
      s(doc, "text", { x: f.L + f.pw + 8, y: y(cap) + 4, class: "cap-label" }, `cap ${fmt(cap)} SOL`)] : null,
    s(doc, "path", { d: line, fill: "none", stroke: `var(--${key})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    marks.map(([j, k]) => s(doc, "line", { x1: f.x(j), x2: f.x(j), y1: 2, y2: 4 + Math.min(14, 4 + k * 1.2), stroke: "var(--refuse)", "stroke-width": 2, "stroke-linecap": "round" })),
    now ? s(doc, "text", { x: Math.min(f.x(i) + 6, f.L + f.pw + 4), y: 14, class: "mark-label" }, `${now} refused this step`) : null,
    s(doc, "circle", { cx: px, cy: py, r: 4.5, fill: `var(--${key})`, stroke: "var(--surface)", "stroke-width": 2 }),
    s(doc, "text", { x: nearEnd ? px - 8 : px + 8, y: Math.max(f.T + 12, py - 10), "text-anchor": nearEnd ? "end" : "start", class: "mark-label" }, `${fmt(st[i].position, 2)} SOL`));
  box.replaceChildren(svg, h(doc, "div", { className: "tip" }));
  return { ...f, n, tip: (j) => `${stepName(st, j)}: ${fmt(st[j].position, 3)} SOL held; refused orders this step: ${refusalsAt(st[j]).length}` };
}

/** One run of the replay at one step: loss (the hero number), refusals, the position chart, the step in words. */
export function renderReplayRun(doc, box, run, i, collateral, opts = {}) {
  const st = run.steps[Math.min(i, run.steps.length - 1)];
  const key = opts.key ?? (run.id === "unguarded" ? "un" : "gu");
  const lossPct = Math.max(0, num(st.lossPct));
  const cap = runCap(run);
  const top = opts.maxY ?? niceMax(Math.max(...run.steps.map((x) => num(x.position)), cap ?? 0));
  const chartBox = h(doc, "div", { className: "chart" });
  const decisions = (st.decisions ?? []).map(plainDecision);
  const refusedSoFar = run.steps.slice(0, i + 1).reduce((a, x) => a + refusalsAt(x).length, 0);
  const when = st.final ? "final" : `so far, at step ${num(st.step) + 1}`;
  box.replaceChildren(...[
    h(doc, "div", { className: "run-head" }, h(doc, "span", { className: `key ${key}` }), h(doc, "span", { className: "run-title" }, String(run.title))),
    h(doc, "div", { className: "run-limits" }, `Limits: ${String(run.limits)}`),
    h(doc, "div", { className: "run-figs" },
      h(doc, "div", null, h(doc, "div", { className: "figure" }, lossPct < 0.05 ? "0.0%" : `-${lossPct.toFixed(1)}%`), h(doc, "div", { className: "figure-label" }, `equity lost, ${when}`)),
      h(doc, "div", { className: "minor" }, `${refusedSoFar} orders ${key === "un" ? "refused by Velocity's margin check" : "refused by Guardrail"} ${st.final ? "in all" : "so far"}`)),
    chartBox,
    h(doc, "div", { className: "caption" },
      `${fmt(st.position, 3)} SOL held${num(st.openBids) ? ` and ${fmt(st.openBids, 3)} SOL bid` : ""}, ${fmt(st.leverage)}x leverage. `,
      cap !== null ? `Binding limit: G4 exposure cap ${fmt(cap)} SOL (dashed line).` : bindingNote(run)),
    st.final ? null : h(doc, "div", { className: "wants" }, `Step ${num(st.step) + 1}: the agent wants +${fmt(st.wants, 4)} SOL at $${num(st.price).toFixed(2)}`),
    st.final ? null : h(doc, "ul", { className: "steplog" }, decisions.length
      ? decisions.map((d) => h(doc, "li", null, h(doc, "span", { className: `chip ${d.kind}` }, d.tag), h(doc, "span", null, d.text)))
      : [h(doc, "li", null, h(doc, "span", { className: "chip info" }, "No orders"), h(doc, "span", null, "no order this step"))]),
  ].filter(Boolean));
  const chart = renderPositionChart(doc, chartBox, run, i, { maxY: top, width: opts.width ?? 520, key });
  return { chartBox, chart };
}
