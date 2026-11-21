import { loadDashboard, allowedRpc } from "./guard-view.js?v=4";
import { renderAgentFeed, renderBars, renderError, renderFeed, renderLastRefusal, renderLimits, renderVelocity } from "./render.js?v=11";
import { themeToggle } from "./theme.js?v=4";

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const short = (a) => `${String(a).slice(0, 4)}...${String(a).slice(-4)}`;
const fetchJson = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };

themeToggle($("theme"));
const [feed, headline] = await Promise.all([fetchJson("./agent-feed.json"), fetchJson("./headline.json")]);
// With no parameters the page shows the recorded language-model run's guard on devnet.
const useFeed = !q.get("guard") && !q.get("rpc") && feed?.guard;
const RPC = useFeed ? allowedRpc(feed.rpc) : allowedRpc(q.get("rpc"));
const GUARD = useFeed ? feed.guard : q.get("guard");
const feedMatches = feed && feed.guard === GUARD;

function status(text, bad) {
  $("status").textContent = text;
  $("status").className = `pill ${bad ? "no" : "ok"}`;
}

function heroLine(g, velocity) {
  const acc = Number(g.acceptedCount);
  const ref = Object.values(g.refused).reduce((a, b) => a + Number(b), 0);
  const p = velocity.positions.find((x) => Number(x.marketIndex) === 0);
  const held = p ? (Math.abs(Number(p.base)) + Number(p.openBids)) / 1e9 : 0;
  const cap = Number(g.limits.markets[0]?.maxExposureBase ?? 0) / 1e9;
  const ask = feedMatches ? "was told to build a 25 SOL long and buy every dip" : `sent ${acc + ref} orders`;
  $("hero").textContent = `The agent ${ask}. Guardrail refused ${ref} of its orders on chain${held >= cap && cap > 0 ? ` and held its exposure at the owner's ${cap} SOL cap` : `; its exposure is ${held.toLocaleString("en-US", { maximumFractionDigits: 3 })} SOL against a ${cap} SOL cap`}.`;
  if (headline) {
    $("hero-note").textContent = `In the replay with real fills and a falling price, the same limits kept the worst loss to ${Number(headline.guarded.worstLossPct)}% against ${Number(headline.unguarded.worstLossPct)}% unguarded, with ${Number(headline.guarded.breaches)} limit breaches.`;
  }
}

function render({ guard: g, velocity, decisions }) {
  const revoked = g.agent === "11111111111111111111111111111111";
  status(revoked ? "agent revoked" : g.paused ? "paused" : "guarding", revoked || g.paused);
  $("ids").textContent = `guard ${short(GUARD)}, agent ${revoked ? "none" : short(g.agent)}, owner ${short(g.owner)}, rpc ${new URL(RPC).hostname}`;
  heroLine(g, velocity);
  $("c-acc").textContent = String(Number(g.acceptedCount));
  $("c-ref").textContent = String(Object.values(g.refused).reduce((a, b) => a + Number(b), 0));
  renderBars(document, $("bars"), g.refused);
  renderLastRefusal(document, $("last"), g.lastRefusal);
  renderVelocity(document, $("velocity"), velocity);
  renderFeed(document, $("feed"), decisions);
  renderLimits(document, $("limits"), g);
  if (feedMatches) {
    const joined = renderAgentFeed(document, $("agent-feed"), feed, decisions);
    $("agent-sub").textContent = `${String(feed.label)} Model: ${String(feed.model)}. ${joined ? "Each order is matched to its on-chain decision by slot." : "Its orders are shown as the agent logged them."}`;
  }
}

// Show the agent's recorded words at once; the on-chain verdicts are matched in when the RPC answers.
if (feed) renderAgentFeed(document, $("agent-feed"), feed, null);
$("agent-sub").textContent = !feed ? "" : feedMatches ? `${String(feed.label)} Model: ${String(feed.model)}. Matching each order to the chain...` : `A recorded run on a different guard (${short(feed.guard)}): ${String(feed.label)}`;

async function tick() {
  if (!RPC) { status("rpc not allowed: use a local validator or Solana's public devnet or mainnet RPC", true); return; }
  if (!GUARD) { status("add ?guard=<address>", true); return; }
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(RPC);
  try { render(await loadDashboard(RPC, GUARD, isLocal ? 40 : 25, isLocal ? 0 : 400)); }
  catch (e) { status("could not read the guard", true); renderError(document, $("feed"), `${e.message}. Check the guard address and the RPC, then reload.`); }
}
tick();
// Local validators refresh every 3 s; public RPCs every 20 s with fewer transactions (rate limits).
const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(RPC ?? "");
setInterval(tick, local ? 3000 : 20000);
