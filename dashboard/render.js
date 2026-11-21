// Dashboard rendering with DOM nodes and textContent only (no HTML parsing of any value from the RPC).
import { RULES, REASONS } from "./guard-view.js";

const num = (x) => Number(x);
const sol = (b) => (num(b) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
const usd = (b) => (num(b) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ORDER_TYPES = { 0: "market", 1: "limit", 2: "trigger market", 3: "trigger limit", 4: "oracle" };
const ruleName = (r) => RULES[r] ?? String(r);
const reasonName = (r) => REASONS[r] ?? String(r);

/** h(doc, "td", {className: "mono"}, "text", childNode, ...) */
export function h(doc, tag, props, ...children) {
  const el = doc.createElement(tag);
  if (props?.className) el.className = props.className;
  if (props?.width !== undefined) el.style.width = `${num(props.width)}%`;
  for (const c of children.flat()) {
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
    return "order shape not allowed";
  }
  if (rule === 6 && reason === 6028) return `exit with an oracle ${num(v)} slots old (over ${num(cap)}) priced against the owner`;
  if (rule === 5 && reason === 6022) return "a non-quote spot balance or quote borrow exists";
  if (rule === 5 && reason === 6024) return "account equity is not positive";
  switch (rule) {
    case 1: case 4: return `${sol(v)} SOL vs cap ${sol(cap)} SOL`;
    case 3: return `${usd(v)} dUSDT today vs cap ${usd(cap)}`;
    case 5: return `worst-case leverage ${(num(v) / 1e4).toFixed(2)}x vs cap ${(num(cap) / 1e4).toFixed(2)}x`;
    case 6: return `${(num(v) / 100).toFixed(2)}% from oracle vs band ${(num(cap) / 100).toFixed(2)}%`;
    case 7: return "guard paused by the owner";
    default: return "";
  }
}

export function renderError(doc, box, message) {
  box.replaceChildren(h(doc, "p", { className: "err" }, String(message)));
}

export function renderBars(doc, box, refused) {
  const names = { G1: "G1 order size", G2: "G2 allowlist", G3: "G3 daily notional", G4: "G4 exposure", G5: "G5 leverage", G6: "G6 price band", G7: "G7 paused" };
  const max = Math.max(1, ...Object.values(refused).map(num));
  box.replaceChildren(...Object.entries(refused).map(([k, n]) =>
    h(doc, "div", { className: "bar" }, h(doc, "span", null, names[k] ?? k), h(doc, "div", { className: "track" }, h(doc, "div", { className: "fill", width: (num(n) / max) * 100 })), h(doc, "span", { className: "n" }, String(num(n))))));
}

export function renderLastRefusal(doc, box, lr) {
  if (!lr.reason) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No refusals yet.")); return; }
  const kv = [["rule", ruleName(lr.rule)], ["reason", reasonName(lr.reason)], ["measured", measure(lr.rule, lr.value, lr.cap, lr.reason)], ["slot", String(lr.slot)]];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

export function renderVelocity(doc, box, velocity) {
  const rows = [];
  if (velocity.positions.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["position", "size", "open bids", "open asks"].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.positions.map((p) => h(doc, "tr", null,
      h(doc, "td", null, `market ${num(p.marketIndex)}`), h(doc, "td", null, `${sol(p.base)} SOL`), h(doc, "td", null, `${sol(p.openBids)} SOL`), h(doc, "td", null, `${sol(Math.abs(num(p.openAsks)))} SOL`)))));
  }
  if (velocity.orders.length) {
    rows.push(h(doc, "thead", null, h(doc, "tr", null, ["open order", "size", "price", ""].map((t) => h(doc, "th", null, t)))));
    rows.push(h(doc, "tbody", null, velocity.orders.map((o) => h(doc, "tr", null,
      h(doc, "td", null, `#${num(o.orderId)} ${o.side === "long" ? "long" : "short"}`), h(doc, "td", null, `${sol(o.size)} SOL`), h(doc, "td", null, `@ ${usd(o.price)}`), h(doc, "td", null, `filled ${sol(o.filled)}`)))));
  }
  box.replaceChildren(rows.length ? h(doc, "table", null, rows) : h(doc, "p", { className: "empty" }, "No positions or open orders."));
}

export function renderFeed(doc, box, decisions) {
  if (!decisions.length) { box.replaceChildren(h(doc, "p", { className: "empty" }, "No orders yet.")); return; }
  const head = h(doc, "thead", null, h(doc, "tr", null, ["slot", "", "order", "rule", "measured"].map((t) => h(doc, "th", null, t))));
  const body = h(doc, "tbody", null, decisions.map((d) => {
    const measured = d.accepted ? (d.rule === 9 ? "exit inside the band" : measure(5, d.value, d.cap)) : measure(d.rule, d.value, d.cap, d.reason);
    return h(doc, "tr", null,
      h(doc, "td", { className: "mono" }, String(d.slot)),
      h(doc, "td", null, h(doc, "span", { className: `tag ${d.accepted ? "ok" : "no"}` }, d.accepted ? "ACCEPTED" : "REFUSED")),
      h(doc, "td", null, `${num(d.direction) === 0 ? "long" : "short"} ${sol(d.size)}${d.reduceOnly ? " (exit)" : ""}`),
      h(doc, "td", null, ruleName(d.rule), d.reason ? h(doc, "div", { className: "addr" }, reasonName(d.reason)) : null),
      h(doc, "td", null, measured));
  }));
  box.replaceChildren(h(doc, "table", null, head, body));
}

export function renderLimits(doc, box, g) {
  const l = g.limits;
  const types = [["market", 1], ["limit", 2], ["oracle", 16]].filter(([, b]) => num(l.allowedOrderTypes) & b).map(([n]) => n).join(", ");
  const kv = [
    ["G1 per order", `${sol(l.maxOrderBase)} SOL`],
    ["G2 markets", l.markets.map((m) => num(m.marketIndex)).join(", ") || "none"],
    ["G2 order types", types],
    ["G3 per UTC day", `${usd(l.dailyNotionalCap)} dUSDT (used ${usd(g.dayNotional)})`],
    ...l.markets.map((m) => [`G4 market ${num(m.marketIndex)}`, `${sol(m.maxExposureBase)} SOL worst case`]),
    ["G5 leverage", `${(num(l.maxLeverageBps) / 1e4).toFixed(2)}x worst case`],
    ["G6 band", `${(num(l.priceBandBps) / 100).toFixed(2)}% of oracle`],
    ["G6 oracle age", `${num(l.maxOracleStalenessSlots)} slots`],
    ["G9 exits", `always, inside the band; oracle older than ${num(l.exitMaxStalenessSlots)} slots: owner-favourable prices only`],
    ["withdraw", "impossible"],
  ];
  box.replaceChildren(h(doc, "dl", { className: "kv" }, kv.flatMap(([k, v]) => [h(doc, "dt", null, k), h(doc, "dd", null, v)])));
}

/** One run of the replay at one step: headline numbers, the step's decisions and an equity bar. DOM nodes only. */
export function renderReplayRun(doc, box, run, i, collateral) {
  const s = run.steps[Math.min(i, run.steps.length - 1)];
  const lossPct = Math.max(0, num(s.lossPct));
  const decisions = (s.decisions ?? []).map((d) => {
    const ok = d.result === "accepted";
    const label = ok ? `+${num(d.size)} SOL accepted, filled ${num(d.filled)}` : `${num(d.size)} SOL refused by ${String(d.by)}`;
    return h(doc, "li", null, h(doc, "span", { className: `tag ${ok ? "ok" : "no"}` }, ok ? "ACCEPTED" : d.result === "velocity" ? "VELOCITY" : "REFUSED"), " ", label);
  });
  box.replaceChildren(
    h(doc, "div", { className: "rp-title" }, String(run.title)),
    h(doc, "div", { className: "addr" }, `limits: ${String(run.limits)}`),
    h(doc, "div", { className: `big ${lossPct > 10 ? "no" : "ok"}` }, lossPct < 0.05 ? "0.0%" : `-${lossPct.toFixed(1)}%`),
    h(doc, "div", { className: "sub" }, "loss of equity so far"),
    h(doc, "div", { className: "track rp-eq" }, h(doc, "div", { className: `fill ${lossPct > 10 ? "" : "okfill"}`, width: Math.max(0, Math.min(100, (num(s.equity) / num(collateral)) * 100)) })),
    h(doc, "dl", { className: "kv" },
      h(doc, "dt", null, "SOL price"), h(doc, "dd", null, `$${num(s.price).toFixed(2)}`),
      h(doc, "dt", null, "position"), h(doc, "dd", null, `${num(s.position).toFixed(3)} SOL long`),
      h(doc, "dt", null, "open bids"), h(doc, "dd", null, `${num(s.openBids).toFixed(3)} SOL`),
      h(doc, "dt", null, "equity"), h(doc, "dd", null, `${num(s.equity).toFixed(2)} dUSDT (uPnL ${num(s.upnl).toFixed(2)})`),
      h(doc, "dt", null, "leverage"), h(doc, "dd", null, `${num(s.leverage).toFixed(2)}x`)),
    h(doc, "div", { className: "sub" }, `step ${num(s.step) + 1}: the agent wants +${num(s.wants)} SOL`),
    h(doc, "ul", { className: "rp-list" }, decisions.length ? decisions : [h(doc, "li", null, "no orders")]),
  );
}
