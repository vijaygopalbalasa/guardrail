import { loadDashboard, allowedRpc } from "./guard-view.js";
import { renderBars, renderError, renderFeed, renderLastRefusal, renderLimits, renderVelocity } from "./render.js";

const q = new URLSearchParams(location.search);
const RPC = allowedRpc(q.get("rpc"));
const GUARD = q.get("guard");
const $ = (id) => document.getElementById(id);
const short = (a) => `${String(a).slice(0, 4)}...${String(a).slice(-4)}`;

async function headline() {
  try {
    const h = await (await fetch("./headline.json")).json();
    $("h-un").textContent = `-${Number(h.unguarded.worstLossPct)}%`;
    $("h-un-sub").textContent = `unguarded: worst loss ${h.unguarded.worstLoss} of ${h.collateral} dUSDT, ${h.unguarded.maxPositionSol} SOL at ${h.unguarded.maxLeverage}x; stopped only by ${h.unguarded.stoppedBy}`;
    $("h-gu").textContent = `-${Number(h.guarded.worstLossPct)}%`;
    $("h-gu-sub").textContent = `guarded: worst loss ${h.guarded.worstLoss} dUSDT, at most ${h.guarded.maxPositionSol} SOL at ${h.guarded.maxLeverage}x; refused ${Object.entries(h.guarded.refused).map(([k, n]) => `${n} by ${k}`).join(", ")}`;
    $("h-br").textContent = String(Number(h.guarded.breaches));
    $("h-label").textContent = h.label;
  } catch { $("headline-panel").style.display = "none"; }
}

function status(text, bad) {
  $("status").textContent = text;
  $("status").className = `pill ${bad ? "no" : "ok"}`;
}

function render({ guard: g, velocity, decisions }) {
  const revoked = g.agent === "11111111111111111111111111111111";
  status(revoked ? "agent revoked" : g.paused ? "paused" : "guarding", revoked || g.paused);
  $("ids").textContent = `guard ${short(GUARD)} · agent ${revoked ? "none" : short(g.agent)} · owner ${short(g.owner)}`;
  $("c-acc").textContent = String(Number(g.acceptedCount));
  $("c-ref").textContent = String(Object.values(g.refused).reduce((a, b) => a + Number(b), 0));
  renderBars(document, $("bars"), g.refused);
  renderLastRefusal(document, $("last"), g.lastRefusal);
  renderVelocity(document, $("velocity"), velocity);
  renderFeed(document, $("feed"), decisions);
  renderLimits(document, $("limits"), g);
}

async function tick() {
  if (!RPC) { status("rpc not allowed: use a local validator or Solana's public devnet or mainnet RPC", true); return; }
  if (!GUARD) { status("add ?guard=<address>", true); return; }
  try { render(await loadDashboard(RPC, GUARD)); }
  catch (e) { status("error", true); renderError(document, $("feed"), e.message); }
}
headline();
tick();
setInterval(tick, 3000);
