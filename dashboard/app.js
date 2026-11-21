import { loadDashboard, RULES, REASONS } from "./guard-view.js";

const q = new URLSearchParams(location.search);
const RPC = q.get("rpc") ?? "http://127.0.0.1:8999";
const GUARD = q.get("guard");
const $ = (id) => document.getElementById(id);
const sol = (b) => (Number(b) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
const usd = (b) => (Number(b) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (a) => `${a.slice(0, 4)}...${a.slice(-4)}`;

/** Formats a rule's measured value and cap in its own units. */
const ORDER_TYPES = { 0: "market", 1: "limit", 2: "trigger market", 3: "trigger limit", 4: "oracle" };
function measure(rule, v, cap, reason) {
  if (rule === 2) {
    if (reason === 6001) return `market ${v} is not on the allowlist`;
    if (reason === 6002) return `${ORDER_TYPES[Number(v)] ?? v} orders are not allowed`;
    if (reason === 6003) return "builder fields must be empty";
    if (reason === 6015) return "trigger orders are not supported";
    return "order shape not allowed";
  }
  if (rule === 5 && reason === 6022) return "a non-quote spot balance or quote borrow exists";
  if (rule === 5 && reason === 6024) return "account equity is not positive";
  switch (rule) {
    case 1: case 4: return `${sol(v)} SOL vs cap ${sol(cap)} SOL`;
    case 3: return `${usd(v)} dUSDT today vs cap ${usd(cap)}`;
    case 5: return `worst-case leverage ${(Number(v) / 1e4).toFixed(2)}x vs cap ${(Number(cap) / 1e4).toFixed(2)}x`;
    case 6: return `${(Number(v) / 100).toFixed(2)}% from oracle vs band ${(Number(cap) / 100).toFixed(2)}%`;
    case 7: return "guard paused by the owner";
    default: return "";
  }
}

async function headline() {
  try {
    const h = await (await fetch("./headline.json")).json();
    $("h-un").textContent = `-${h.unguarded.worstLossPct}%`;
    $("h-un-sub").textContent = `unguarded: worst loss ${h.unguarded.worstLoss} of ${h.collateral} dUSDT, ${h.unguarded.maxPositionSol} SOL at ${h.unguarded.maxLeverage}x; stopped only by ${h.unguarded.stoppedBy}`;
    $("h-gu").textContent = `-${h.guarded.worstLossPct}%`;
    $("h-gu-sub").textContent = `guarded: worst loss ${h.guarded.worstLoss} dUSDT, at most ${h.guarded.maxPositionSol} SOL at ${h.guarded.maxLeverage}x; refused ${Object.entries(h.guarded.refused).map(([k, n]) => `${n} by ${k}`).join(", ")}`;
    $("h-br").textContent = h.guarded.breaches;
    $("h-label").textContent = h.label;
  } catch { $("headline-panel").style.display = "none"; }
}

function render({ guard: g, velocity, decisions }) {
  const revoked = g.agent === "11111111111111111111111111111111";
  const st = $("status");
  st.textContent = revoked ? "agent revoked" : g.paused ? "paused" : "guarding";
  st.className = `pill ${revoked || g.paused ? "no" : "ok"}`;
  $("ids").textContent = `guard ${short(GUARD)} · agent ${revoked ? "none" : short(g.agent)} · owner ${short(g.owner)}`;
  const refusedTotal = Object.values(g.refused).reduce((a, b) => a + b, 0n);
  $("c-acc").textContent = g.acceptedCount.toString();
  $("c-ref").textContent = refusedTotal.toString();
  const max = Number(Object.values(g.refused).reduce((a, b) => (b > a ? b : a), 1n));
  const names = { G1: "G1 order size", G2: "G2 allowlist", G3: "G3 daily notional", G4: "G4 exposure", G5: "G5 leverage", G6: "G6 price band", G7: "G7 paused" };
  $("bars").innerHTML = Object.entries(g.refused).map(([k, n]) =>
    `<div class="bar"><span>${names[k]}</span><div class="track"><div class="fill" style="width:${(Number(n) / max) * 100}%"></div></div><span class="n">${n}</span></div>`).join("");
  const lr = g.lastRefusal;
  $("last").innerHTML = lr.reason
    ? `<dl class="kv"><dt>rule</dt><dd>${esc(RULES[lr.rule] ?? lr.rule)}</dd><dt>reason</dt><dd>${esc(REASONS[lr.reason] ?? lr.reason)}</dd><dt>measured</dt><dd>${esc(measure(lr.rule, lr.value, lr.cap, lr.reason))}</dd><dt>slot</dt><dd>${lr.slot}</dd></dl>`
    : `<p class="empty">No refusals yet.</p>`;
  const pos = velocity.positions.map((p) => `<tr><td>market ${p.marketIndex}</td><td>${sol(p.base)} SOL</td><td>${sol(p.openBids)} SOL</td><td>${sol(-p.openAsks)} SOL</td></tr>`).join("");
  const ord = velocity.orders.map((o) => `<tr><td>#${o.orderId} ${o.side}</td><td>${sol(o.size)} SOL</td><td>@ ${usd(o.price)}</td><td>filled ${sol(o.filled)}</td></tr>`).join("");
  $("velocity").innerHTML = (pos || ord)
    ? `<table>${pos ? `<thead><tr><th>position</th><th>size</th><th>open bids</th><th>open asks</th></tr></thead><tbody>${pos}</tbody>` : ""}${ord ? `<thead><tr><th>open order</th><th>size</th><th>price</th><th></th></tr></thead><tbody>${ord}</tbody>` : ""}</table>`
    : `<p class="empty">No positions or open orders.</p>`;
  $("feed").innerHTML = decisions.length
    ? `<table><thead><tr><th>slot</th><th></th><th>order</th><th>rule</th><th>measured</th></tr></thead><tbody>${decisions.map((d) => `<tr>
        <td class="mono">${d.slot}</td>
        <td><span class="tag ${d.accepted ? "ok" : "no"}">${d.accepted ? "ACCEPTED" : "REFUSED"}</span></td>
        <td>${d.direction === 0 ? "long" : "short"} ${sol(d.size)}${d.reduceOnly ? " (exit)" : ""}</td>
        <td>${esc(RULES[d.rule] ?? d.rule)}${d.reason ? `<div class="addr">${esc(REASONS[d.reason] ?? d.reason)}</div>` : ""}</td>
        <td>${d.accepted ? (d.rule === 9 ? "exit inside the band" : esc(measure(5, d.value, d.cap))) : esc(measure(d.rule, d.value, d.cap, d.reason))}</td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">No orders yet.</p>`;
  const l = g.limits;
  const types = [["market", 1], ["limit", 2], ["oracle", 16]].filter(([, b]) => l.allowedOrderTypes & b).map(([n]) => n).join(", ");
  $("limits").innerHTML = `<dl class="kv">
    <dt>G1 per order</dt><dd>${sol(l.maxOrderBase)} SOL</dd>
    <dt>G2 markets</dt><dd>${l.markets.map((m) => m.marketIndex).join(", ") || "none"}</dd>
    <dt>G2 order types</dt><dd>${types}</dd>
    <dt>G3 per UTC day</dt><dd>${usd(l.dailyNotionalCap)} dUSDT (used ${usd(g.dayNotional)})</dd>
    ${l.markets.map((m) => `<dt>G4 market ${m.marketIndex}</dt><dd>${sol(m.maxExposureBase)} SOL worst case</dd>`).join("")}
    <dt>G5 leverage</dt><dd>${(l.maxLeverageBps / 1e4).toFixed(2)}x worst case</dd>
    <dt>G6 band</dt><dd>${(l.priceBandBps / 100).toFixed(2)}% of oracle</dd>
    <dt>G6 oracle age</dt><dd>${l.maxOracleStalenessSlots} slots</dd>
    <dt>G9 exits</dt><dd>always, inside the band</dd>
    <dt>withdraw</dt><dd>impossible</dd></dl>`;
}

async function tick() {
  if (!GUARD) { $("status").textContent = "add ?guard=<address>"; return; }
  try { render(await loadDashboard(RPC, GUARD)); }
  catch (e) { $("status").textContent = "error"; $("status").className = "pill no"; $("feed").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
headline();
tick();
setInterval(tick, 3000);
