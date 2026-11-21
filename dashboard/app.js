import { loadDashboard, allowedRpc } from "./guard-view.js?v=22";
import { ago, explorerUrl, link, renderAgentFeed, renderError, renderFeed, renderHeadroom, renderLastRefusal, renderLimits, renderRefusals, renderVelocity } from "./render.js?v=22";
import { themeToggle } from "./theme.js?v=4";

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const short = (a) => `${String(a).slice(0, 4)}...${String(a).slice(-4)}`;
const fetchJson = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
const PROGRAM = "BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy";

themeToggle($("theme"));
const [feed, headline] = await Promise.all([fetchJson("./agent-feed.json"), fetchJson("./headline.json")]);
// With no parameters the page shows the recorded language-model run's guard on devnet.
const useFeed = !q.get("guard") && !q.get("rpc") && feed?.guard;
const RPC = useFeed ? allowedRpc(feed.rpc) : allowedRpc(q.get("rpc"));
const GUARD = useFeed ? feed.guard : q.get("guard");
const feedMatches = feed && feed.guard === GUARD;
const host = RPC ? new URL(RPC).hostname : "";
const CLUSTER = host === "api.devnet.solana.com" ? "devnet" : host === "api.mainnet-beta.solana.com" ? "mainnet" : null;
const NET = CLUSTER ?? "local validator";
const sol = (b) => (Number(b) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });

if (headline) {
  $("replay-text").textContent = `Same limits, real fills, a falling price: worst loss ${Number(headline.guarded.worstLossPct)}% guarded against ${Number(headline.unguarded.worstLossPct)}% unguarded, ${Number(headline.guarded.breaches)} limit breaches.`;
  $("replay-strip").hidden = false;
}

/** "14 min ago", or the date once the last order is more than 2 hours old. */
function lastOrder(t, now) {
  if (now - Number(t) <= 7200) return ago(t, now);
  const d = new Date(Number(t) * 1000);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
}

function status(text, bad) {
  $("status").textContent = text;
  $("status").className = `pill ${bad ? "no" : "ok"}`;
}

function heroLine(g, velocity) {
  const ref = Object.values(g.refused).reduce((a, b) => a + Number(b), 0);
  const acc = Number(g.acceptedCount);
  const p = velocity.positions.find((x) => Number(x.marketIndex) === 0);
  const base = p ? Number(p.base) : 0, bids = p ? Number(p.openBids) : 0;
  const cap = Number(g.limits.markets[0]?.maxExposureBase ?? 0);
  const ask = feedMatches ? "was told to build a 25 SOL long and buy every dip" : `sent ${acc + ref} orders`;
  const held = base === 0
    ? `left ${sol(bids)} SOL of bids resting${bids >= cap && cap > 0 ? ` at the owner's ${sol(cap)} SOL cap` : ""}. None has filled${CLUSTER === "devnet" ? " (devnet's oracle is stale)" : ""}`
    : `holds ${sol(Math.abs(base))} SOL with ${sol(bids)} SOL bid, against a ${sol(cap)} SOL cap`;
  $("hero").textContent = acc + ref === 0
    ? "This guard is live. The agent has sent no orders yet; each one it sends is checked here, on chain, against the owner's limits."
    : `The agent ${ask}. Guardrail refused ${ref} of its orders on chain and ${held}.`;
}

function verify(decisions) {
  if (!CLUSTER) { $("verify").replaceChildren(); return; }
  const refusal = decisions.find((d) => !d.accepted);
  const parts = ["Verify it yourself: guard program ", link(document, explorerUrl("address", PROGRAM, CLUSTER), short(PROGRAM)), ", guard account ", link(document, explorerUrl("address", GUARD, CLUSTER), short(GUARD))];
  if (refusal) parts.push(", a refusal ", link(document, explorerUrl("tx", refusal.signature, CLUSTER), `(slot ${refusal.slot})`));
  parts.push(".");
  $("verify").replaceChildren(...parts.map((x) => (typeof x === "string" ? document.createTextNode(x) : x)));
}

function render({ guard: g, velocity, decisions, slot }) {
  const now = Date.now() / 1000;
  const revoked = g.agent === "11111111111111111111111111111111";
  const last = decisions.find((d) => d.blockTime);
  const state = revoked ? "agent revoked" : g.paused ? "paused by the owner" : "guard active";
  status(`Live on ${NET}, ${state}${slot ? `, slot ${Number(slot).toLocaleString("en-US")}` : ""}${last ? `, last order ${lastOrder(last.blockTime, now)}` : ", no orders yet"}`, revoked || g.paused);
  heroLine(g, velocity);
  verify(decisions);
  $("c-acc").textContent = String(Number(g.acceptedCount));
  $("c-ref").textContent = String(Object.values(g.refused).reduce((a, b) => a + Number(b), 0));
  renderHeadroom(document, $("headroom"), g, velocity, decisions, now);
  renderRefusals(document, $("refusals"), g.refused);
  renderLastRefusal(document, $("last"), g.lastRefusal, decisions, CLUSTER);
  renderVelocity(document, $("velocity"), velocity);
  $("velocity-note").textContent = CLUSTER === "devnet" ? "Devnet's oracle is stale, so orders rest here and do not fill. Fills at moving prices are in the replay." : "";
  renderFeed(document, $("feed"), decisions, CLUSTER, now);
  renderLimits(document, $("limits"), g);
  if (feedMatches) {
    const joined = renderAgentFeed(document, $("agent-feed"), feed, decisions, CLUSTER);
    $("agent-sub").textContent = `${String(feed.label)} Model: ${String(feed.model)}. ${joined ? "Each order links to its transaction." : "Its orders are shown as the agent logged them."}`;
  }
  const ids = [["guard", GUARD], ["agent", revoked ? null : g.agent], ["owner", g.owner]].filter(([, v]) => v);
  $("ids").replaceChildren(...ids.flatMap(([k, v], i) => [document.createTextNode(`${i ? ", " : ""}${k} `), link(document, explorerUrl("address", v, CLUSTER), short(v), "mono")]),
    document.createTextNode(`, rpc ${host}`));
}

// Show the agent's recorded words at once; the on-chain verdicts are matched in when the RPC answers.
if (feed) renderAgentFeed(document, $("agent-feed"), feed, null, null);
$("agent-sub").textContent = !feed ? "" : feedMatches ? `${String(feed.label)} Model: ${String(feed.model)}. Matching each order to the chain...` : `A recorded run on a different guard (${short(feed.guard)}): ${String(feed.label)}`;

async function tick() {
  if (!RPC) { status("rpc not allowed: use a local validator or Solana's public devnet or mainnet RPC", true); return; }
  if (!GUARD) { status("add ?guard=<address>", true); return; }
  const isLocal = !CLUSTER;
  try { render(await loadDashboard(RPC, GUARD, isLocal ? 40 : 25, isLocal ? 0 : 400)); }
  catch (e) { status("could not read the guard", true); renderError(document, $("feed"), `${e.message}. Check the guard address and the RPC, then reload.`); }
}
tick();
// Local validators refresh every 3 s; public RPCs every 20 s with fewer transactions (rate limits).
setInterval(tick, CLUSTER ? 20000 : 3000);
