import { loadDashboard, allowedRpc } from "./guard-view.js?v=34";
import { ago, explorerUrl, link, renderAgentFeed, renderError, renderFeed, renderFillsRun, renderHeadroom, renderLastRefusal, renderLimits, renderRefusals, renderVelocity, setQuoteUnit } from "./render.js?v=34";
import { themeToggle } from "./theme.js?v=4";

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const short = (a) => `${String(a).slice(0, 4)}...${String(a).slice(-4)}`;
const fetchJson = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
const PROGRAM = "BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy";

themeToggle($("theme"));
const [feed, headline, fills, snapshot, build] = await Promise.all([fetchJson("./agent-feed.json"), fetchJson("./headline.json"), fetchJson("./fills-run.json"), fetchJson("./snapshot.json"), fetchJson("./build.json")]);
if (build && /^[0-9a-f]{7,40}$/.test(String(build.commit)) && /^[0-9a-f]{64}$/.test(String(build.sha256))) {
  $("build").textContent = `The devnet program was built from commit ${build.commit}; the deployed bytes hash to sha256 ${String(build.sha256).slice(0, 16)}... (trailing zero padding stripped).`;
}
if (fills) {
  const refused = Object.values(fills.refused ?? {}).reduce((a, b) => a + Number(b), 0);
  $("hero").textContent = `The runaway agent kept doubling a losing long. Guardrail refused ${refused} of its orders and held it at its ${Number(fills.capSol)} SOL cap, while SOL fell from $${Number(fills.start).toFixed(2)} to $${Number(fills.end).toFixed(2)}.`;
  renderFillsRun(document, $("fills"), fills);
}
// With no parameters the page shows the recorded language-model run's guard on devnet.
const useFeed = !q.get("guard") && !q.get("rpc") && feed?.guard;
const RPC = useFeed ? allowedRpc(feed.rpc) : allowedRpc(q.get("rpc"));
const GUARD = useFeed ? feed.guard : q.get("guard");
const feedMatches = feed && feed.guard === GUARD;
const host = RPC ? new URL(RPC).hostname : "";
const CLUSTER = host === "api.devnet.solana.com" ? "devnet" : host === "api.mainnet-beta.solana.com" ? "mainnet" : null;
const NET = CLUSTER ?? "local validator";
const sol = (b) => (Number(b) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });

/** The demo guards on devnet a visitor can switch between (receipts: notes/devnet-receipts.md). */
const DEVNET_GUARDS = [
  { guard: "9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8", name: "the language-model agent's guard", label: "Language-model agent" },
  { guard: "HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg", name: "the scripted runaway agent's guard", label: "Scripted runaway agent (31 refusals)" },
];
if (CLUSTER === "devnet" || useFeed) {
  const known = DEVNET_GUARDS.find((x) => x.guard === GUARD);
  $("live-title").textContent = known ? `On devnet now: ${known.name}` : "On devnet now: your guard";
  $("guard-pick").replaceChildren(document.createTextNode("Devnet guards: "), ...DEVNET_GUARDS.flatMap((x, i) => {
    const a = document.createElement("a");
    a.textContent = x.label;
    a.href = `?${new URLSearchParams({ rpc: "https://api.devnet.solana.com", guard: x.guard })}`;
    if (x.guard === GUARD) a.setAttribute("aria-current", "page");
    return i ? [document.createTextNode(" / "), a] : [a];
  }));
  $("guard-pick").hidden = false;
} else if (RPC && GUARD) {
  $("live-title").textContent = CLUSTER === "mainnet" ? `On mainnet now: guard ${short(GUARD)}` : `On a local RPC now (${new URL(RPC).host}): guard ${short(GUARD)}`;
}
// The recorded language-model run (agent-feed.json) belongs to a devnet guard: elsewhere it is not shown.
const showFeed = Boolean(feed) && (feedMatches || CLUSTER === "devnet");
if (feed && !showFeed) $("agent-feed").closest("section").hidden = true;

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
  $("live-hero").textContent = acc + ref === 0
    ? "This guard is live. The agent has sent no orders yet; each one it sends is checked here, on chain, against the owner's limits."
    : `The agent ${ask}. Guardrail refused ${ref} of its orders on chain and ${held}.`;
}

/** demo/bypass-attempt.mjs on devnet: the agent's direct Velocity order, withdraw and delegate change, each failed on chain. */
const BYPASS = { "9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8": ["3R6bp6TxN4SuXUMGkrMPf5mk36EDsZr5oR5pzREVtjM9QCbWtdU5mCQYEoDxDZbHdp12qc3YYfF9yMM36D5zeKAa", "MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3", "2MuwW1j9gLr1dJJVsxizxWCGfW2AuVYV9WwhbXTXPiuBLTd34X3hJe7WqNUjtoszCDGhK8X7hkpCnJxhTSm6ugiQ"] };

function verify(decisions) {
  if (!CLUSTER) { $("verify").replaceChildren(); return; }
  const refusal = decisions.find((d) => !d.accepted);
  const parts = ["Verify it yourself: guard program ", link(document, explorerUrl("address", PROGRAM, CLUSTER), short(PROGRAM)), ", guard account ", link(document, explorerUrl("address", GUARD, CLUSTER), short(GUARD))];
  if (refusal) parts.push(", a refusal ", link(document, explorerUrl("tx", refusal.signature, CLUSTER), `(slot ${refusal.slot})`));
  parts.push(".");
  const bypass = BYPASS[GUARD];
  if (bypass && CLUSTER === "devnet") parts.push(" The agent's own key tried to go around the guard and Velocity refused all three: a direct ", link(document, explorerUrl("tx", bypass[0], CLUSTER), "order"), ", a ", link(document, explorerUrl("tx", bypass[1], CLUSTER), "withdraw"), " and a ", link(document, explorerUrl("tx", bypass[2], CLUSTER), "delegate change"), ".");
  $("verify").replaceChildren(...parts.map((x) => (typeof x === "string" ? document.createTextNode(x) : x)));
}

function render({ guard: g, velocity, decisions, slot, takenAt, checkpoints, quote }) {
  const now = Date.now() / 1000;
  if (quote) {
    setQuoteUnit(quote);
    $("units").textContent = `Reads the Guard account and its transactions straight from the RPC. Sizes in SOL, notional in ${quote === "USDT" ? "USDT" : "dUSDT"}.`;
  }
  const revoked = g.agent === "11111111111111111111111111111111";
  const last = decisions.find((d) => d.blockTime);
  const state = revoked ? "agent revoked" : g.paused ? "paused by the owner" : "guard active";
  const lastRun = last ? `, last agent run ${lastOrder(last.blockTime, now)}` : ", no agent orders yet";
  if (takenAt) status(`Saved read of ${NET} from ${lastOrder(takenAt, now)}${lastRun}; reading live now`, false);
  else status(`Live read of ${NET}, ${state}${slot ? `, slot ${Number(slot).toLocaleString("en-US")}` : ""}${lastRun}`, revoked || g.paused);
  heroLine(g, velocity);
  verify(decisions);
  $("c-acc").textContent = String(Number(g.acceptedCount));
  $("c-ref").textContent = String(Object.values(g.refused).reduce((a, b) => a + Number(b), 0));
  renderHeadroom(document, $("headroom"), g, velocity, decisions, now, checkpoints);
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

// First paint: the last saved read of the default guard (snapshot.json), replaced by the live read when it answers.
if (showFeed) renderAgentFeed(document, $("agent-feed"), feed, null, null);
if (snapshot && useFeed && snapshot.guardAddress === GUARD) {
  try { render({ ...snapshot, takenAt: snapshot.takenAt }); } catch { /* the live read follows */ }
}
$("agent-sub").textContent = !feed ? "" : feedMatches ? `${String(feed.label)} Model: ${String(feed.model)}. Matching each order to the chain...` : `A recorded run on a different guard (${short(feed.guard)}): ${String(feed.label)}`;

async function tick() {
  if (!RPC) { status("rpc not allowed: use a local validator or Solana's public devnet or mainnet RPC", true); return; }
  if (!GUARD) { status("add ?guard=<address>", true); return; }
  const isLocal = !CLUSTER;
  try { render(await loadDashboard(RPC, GUARD, 40, isLocal ? 0 : 400)); }
  catch (e) { status("could not read the guard", true); renderError(document, $("feed"), `${e.message}. Check the guard address and the RPC, then reload.`); }
}
tick();
// Local validators refresh every 3 s; public RPCs every 20 s with fewer transactions (rate limits).
setInterval(tick, CLUSTER ? 20000 : 3000);
