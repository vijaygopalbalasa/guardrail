// Owner onboarding on devnet: connect a wallet (Wallet Standard: Phantom, Solflare, Backpack), open a Velocity
// account with test dUSDT, create the guard with limits in plain units, hand the agent a key, and copy the MCP config.
// The wallet signs; this page sends through the allowlisted devnet RPC. Rendering uses DOM APIs only.
import { b58encode, checkedGuard, REASONS, GUARD_PROGRAM_ID } from "./guard-view.js?v=30";
import { themeToggle } from "./theme.js?v=4";
import {
  PRESETS, addressesFor, checkPlain, toLimits, dailyLossUnits, velocitySetupIxs, guardSetupIxs, checkpointIx,
  activeMarkets, perpMarketAddress, pricingAccounts, unsignedTransaction, firstSignature, newAgentKey, mcpConfig,
  parseKey, setupRpc, DEFAULT_KEY,
} from "./setup-tx.js?v=30";

const $ = (id) => document.getElementById(id);
themeToggle($("theme"));

const RPC = setupRpc(new URLSearchParams(location.search).get("rpc"));
const CLUSTER = RPC === "https://api.devnet.solana.com" ? "devnet" : "local";
const AGENT_LAMPORTS = 20_000_000;

const state = {
  wallet: null, account: null, owner: null, addrs: null, startLamports: null,
  hasUser: false, hasStats: false, deposits: 0n, guardExists: false,
  agent: null, agentDownloaded: false, agentFile: "agent.json", txs: [],
};

// ---------- DOM helpers ----------

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
function explorer(kind, value, text) {
  if (CLUSTER !== "devnet" || !/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value)) return el("span", { className: "addr" }, text ?? value);
  const a = el("a", { href: `https://explorer.solana.com/${kind}/${value}?cluster=devnet`, target: "_blank", rel: "noopener noreferrer" }, text ?? value);
  return a;
}
function say(id, text, kind) {
  const n = $(id);
  n.textContent = text;
  n.classList.toggle("err", kind === "err");
  n.classList.toggle("ok-text", kind === "ok");
}
const sol = (lamports) => (Number(lamports) / 1e9).toFixed(4);

// ---------- RPC ----------

/** One JSON-RPC call; the public devnet RPC rate-limits, so a 429 or "rate limit" answer is retried with a pause. */
async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    let res, j;
    try {
      res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      j = res.status === 429 ? null : await res.json();
    } catch (e) {
      if (attempt >= 6) throw e;
    }
    const limited = res?.status === 429 || /rate limit/i.test(j?.error?.message ?? "");
    if ((limited || !j) && attempt < 6) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    if (!j) throw new Error(`${method}: the devnet RPC is busy; try again in a minute`);
    if (j.error) {
      const e = new Error(j.error.message);
      e.logs = j.error.data?.logs ?? [];
      throw e;
    }
    return j.result;
  }
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
async function account(address) {
  const r = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? { owner: r.value.owner, data: fromB64(r.value.data[0]), lamports: r.value.lamports } : null;
}
async function accounts(addresses) {
  const r = await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
  return r.value.map((v) => (v ? { owner: v.owner, data: fromB64(v.data[0]) } : null));
}
const balance = async () => BigInt((await rpc("getBalance", [state.owner, { commitment: "confirmed" }])).value);

/** Plain words for a failed transaction: the guard's own error names first, then the program logs' last line. */
function explain(e) {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(`${e.message} ${(e.logs ?? []).join(" ")}`);
  if (m) {
    const code = parseInt(m[1], 16);
    if (REASONS[code]) return `The guard refused the transaction: ${REASONS[code]} (${code}).`;
    return `A program refused the transaction (error ${code}).`;
  }
  if (/insufficient|0x1\b/i.test(e.message)) return "Not enough devnet SOL. Get some at faucet.solana.com and try again.";
  if (/rejected|declined|cancel/i.test(e.message)) return "You declined it in the wallet. Nothing was sent.";
  return e.message;
}

/** The wallet signs; the page sends to devnet and waits for confirmation. */
async function signAndSend(ixs, label) {
  const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const unsigned = unsignedTransaction(state.owner, ixs, value.blockhash);
  const chain = state.wallet.chains.includes("solana:devnet") ? "solana:devnet" : undefined;
  const [out] = await state.wallet.features["solana:signTransaction"].signTransaction({ account: state.account, transaction: unsigned, ...(chain ? { chain } : {}) });
  const signed = out.signedTransaction;
  const sig = await rpc("sendTransaction", [toB64(signed), { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 60; i++) {
    const s = (await rpc("getSignatureStatuses", [[sig]])).value[0];
    if (s?.err) throw Object.assign(new Error(`${label} failed on chain: ${JSON.stringify(s.err)}`), { logs: [] });
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      state.txs.push({ label, sig });
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: not confirmed after 90 s (signature ${firstSignature(signed)})`);
}

// ---------- 1. wallet (Wallet Standard discovery) ----------

const wallets = [];
function registerWallet(...ws) {
  for (const w of ws) {
    const ok = w?.features?.["standard:connect"] && w.features["solana:signTransaction"] && (w.chains ?? []).some((c) => String(c).startsWith("solana:"));
    if (ok && !wallets.includes(w)) wallets.push(w);
  }
  renderWallets();
  return () => {};
}
const api = Object.freeze({ register: registerWallet });
window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(api); } catch { /* a broken wallet */ } });
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));

function renderWallets() {
  const box = $("wallets");
  if (state.owner) return;
  if (!wallets.length) {
    box.replaceChildren(el("p", { className: "note" }, "No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, switch it to devnet, then reload this page."));
    return;
  }
  box.replaceChildren(...wallets.map((w) => {
    const b = el("button", { className: "button", type: "button" }, `Connect ${String(w.name).slice(0, 40)}`);
    b.addEventListener("click", () => connect(w));
    return b;
  }));
}
setTimeout(renderWallets, 600);

async function connect(w) {
  try {
    say("wallet-status", "Waiting for the wallet...");
    const res = await w.features["standard:connect"].connect();
    const acct = res?.accounts?.[0] ?? w.accounts?.[0];
    if (!acct || !parseKey(acct.address)) throw new Error("the wallet returned no account");
    state.wallet = w;
    state.account = acct;
    state.owner = acct.address;
    state.addrs = await addressesFor(state.owner);
    state.startLamports = await balance();
    $("wallets").replaceChildren(el("span", { className: "pill ok" }, `Owner ${state.owner.slice(0, 4)}...${state.owner.slice(-4)}`));
    const low = state.startLamports < 70_000_000n;
    say("wallet-status", `${sol(state.startLamports)} devnet SOL.${low ? " That is under 0.07; get more at faucet.solana.com before going on." : ""}`, low ? "err" : undefined);
    await refreshChain();
  } catch (e) {
    say("wallet-status", explain(e), "err");
  }
}

// ---------- chain state: what exists already ----------

async function refreshChain() {
  const [user, stats, guard] = await accounts([state.addrs.velocityUser, state.addrs.userStats, state.addrs.guard]);
  state.hasUser = !!user;
  state.hasStats = !!stats;
  state.deposits = user && user.data.length >= 4400 ? new DataView(user.data.buffer).getBigUint64(4392, true) : 0n;
  state.guardExists = !!guard;
  if (state.guardExists) {
    const g = checkedGuard(guard, GUARD_PROGRAM_ID);
    if (!state.createdHere) {
      state.agent?.secret?.fill(0); // a key made on load is not this guard's agent
      state.agent = { publicKey: g.agent === DEFAULT_KEY ? null : g.agent, secret: null };
    }
    say("account-status", "Your Velocity account is set up.", "ok");
    say("guard-status", state.createdHere ? "The guard is live." : "This wallet already has a guard. Change limits or the agent with the owner commands in the repo.", "ok");
    say("wallet-status", `${sol(state.startLamports)} devnet SOL.`);
    showExisting(g);
    renderDone(g);
  } else if (state.deposits > 0n) {
    const usd = (Number(state.deposits) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
    say("account-status", state.justOpened ? "Opened your Velocity account and deposited 1,000 test dUSDT." : `Found your Velocity account; its deposits are worth $${usd} at the dUSDT oracle price.`, "ok");
  } else {
    say("account-status", state.hasUser ? "Found your Velocity account, with nothing deposited yet." : "No Velocity account yet for this wallet.");
  }
  update();
}

$("account-go").addEventListener("click", async () => {
  const b = $("account-go");
  b.disabled = true;
  try {
    say("account-status", "Check your wallet and approve...");
    const ixs = velocitySetupIxs(state.owner, state.addrs, { needStats: !state.hasStats, needUser: !state.hasUser, dusdt: 1000 });
    const sig = await signAndSend(ixs, "Velocity account and 1,000 dUSDT");
    state.justOpened = true;
    await refreshChain();
    $("account-status").append(" ", explorer("tx", sig, "View the transaction"));
  } catch (e) {
    say("account-status", explain(e), "err");
  }
  update();
});

/** A guard exists: the limit fields show its limits (read only) and the agent step shows its agent. */
function showExisting(g) {
  const l = g.limits;
  const vals = {
    orderSol: Number(l.maxOrderBase) / 1e9, exposureSol: Number(l.markets.find((m) => m.marketIndex === 0)?.maxExposureBase ?? 0n) / 1e9,
    dailyVolumeUsd: Number(l.dailyNotionalCap) / 1e6, leverage: l.maxLeverageBps / 10_000, bandPct: l.priceBandBps / 100,
    dailyLossUsd: Number(g.dailyLoss?.max ?? 0n) / 1e6,
  };
  for (const f of FIELDS) { $(`f-${f}`).value = String(vals[f]); $(`f-${f}`).disabled = true; }
  for (const b of document.querySelectorAll(".preset")) { b.disabled = true; b.setAttribute("aria-pressed", "false"); }
  $("step-limits").querySelector(".h2-sub").textContent = "Your guard's limits now, read from the chain.";
  $("agent-new").hidden = true;
  $("agent-paste").hidden = true;
  $("agent-fund").closest("label").hidden = true;
  $("step-agent").querySelector(".choice").hidden = true;
}

// ---------- 3. limits ----------

const FIELDS = ["orderSol", "exposureSol", "dailyVolumeUsd", "leverage", "bandPct", "dailyLossUsd"];
function applyPreset(name) {
  for (const f of FIELDS) $(`f-${f}`).value = String(PRESETS[name][f]);
  for (const b of document.querySelectorAll(".preset")) b.setAttribute("aria-pressed", String(b.dataset.preset === name));
  update();
}
function readPlain() {
  const p = {};
  for (const f of FIELDS) { const v = $(`f-${f}`).value.trim(); p[f] = v === "" ? Number.NaN : Number(v); }
  return p;
}
for (const b of document.querySelectorAll(".preset")) b.addEventListener("click", () => applyPreset(b.dataset.preset));
for (const f of FIELDS) $(`f-${f}`).addEventListener("input", () => {
  for (const b of document.querySelectorAll(".preset")) b.setAttribute("aria-pressed", "false");
  update();
});

// ---------- 4. agent key ----------

for (const r of document.querySelectorAll("input[name=agent-mode]")) r.addEventListener("change", () => {
  const paste = r.value === "paste" && r.checked;
  $("agent-new").hidden = paste;
  $("agent-paste").hidden = !paste;
  update();
});
$("agent-input").addEventListener("input", update);

async function makeAgent() {
  try {
    const k = await newAgentKey();
    state.agent = k;
    state.agentFile = `guardrail-agent-${k.publicKey.slice(0, 8)}.json`;
    $("agent-pub").textContent = `Agent ${k.publicKey}`;
    $("agent-download").disabled = false;
  } catch {
    $("agent-pub").textContent = "This browser cannot make Ed25519 keys. Choose \"Use my own key\" and paste a public key.";
  }
  update();
}
$("agent-download").addEventListener("click", () => {
  if (!state.agent?.secret) return;
  const blob = new Blob([JSON.stringify([...state.agent.secret])], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: state.agentFile });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.agentDownloaded = true;
  $("agent-download").textContent = "Downloaded. Download again";
  update();
});

/** The agent's public key and whether the step is complete, with a reason when it is not. */
function agentChoice() {
  const paste = document.querySelector("input[name=agent-mode]:checked").value === "paste";
  if (!paste) {
    if (!state.agent?.secret) return { ok: false, why: "Making a key..." };
    if (!state.agentDownloaded) return { ok: false, why: "Download the agent key first; it is the only copy." };
    return { ok: true, key: state.agent.publicKey };
  }
  const text = $("agent-input").value.trim();
  if (!text) return { ok: false, why: "Paste the agent's public key." };
  if (!parseKey(text)) return { ok: false, why: "That is not a Solana public key." };
  if (text === DEFAULT_KEY) return { ok: false, why: "That is the empty key; use a real agent key." };
  if (text === state.owner) return { ok: false, why: "The agent must be a different key from your wallet (your wallet is the keeper)." };
  return { ok: true, key: text };
}

// ---------- 5. the guard ----------

$("guard-go").addEventListener("click", async () => {
  const b = $("guard-go");
  b.disabled = true;
  const plain = readPlain();
  const agent = agentChoice();
  try {
    say("guard-status", "Check your wallet and approve...");
    const ixs = guardSetupIxs(state.owner, state.addrs, {
      agent: agent.key, limits: toLimits(plain), dailyLoss: dailyLossUnits(plain), agentLamports: $("agent-fund").checked ? AGENT_LAMPORTS : 0,
    });
    const sig = await signAndSend(ixs, "Guard, keeper and limits");
    state.createdHere = true;
    if (state.agent?.secret) state.agent.secret.fill(0); // the download is the only copy now
    state.agent = { publicKey: agent.key, secret: null };
    await refreshChain();
    say("guard-status", "The guard is live. ", "ok");
    $("guard-status").append(explorer("tx", sig, "View the transaction"));
  } catch (e) {
    say("guard-status", explain(e), "err");
    update();
  }
});

// ---------- 6. done: MCP config, dashboard link, keeper ----------

function copyButton(getText) {
  const b = el("button", { className: "button quiet-button", type: "button" }, "Copy");
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = "Copied"; } catch { b.textContent = "Select and copy by hand"; }
    setTimeout(() => { b.textContent = "Copy"; }, 2000);
  });
  return b;
}

async function renderDone(g) {
  const agentFile = state.createdHere ? state.agentFile : "agent.json";
  const cfg = mcpConfig({ rpc: RPC, owner: state.owner, agentFile });
  const keeper = g.dailyLoss?.keeper ?? DEFAULT_KEY;
  const ownerKeeps = keeper === state.owner;
  const dash = new URL("./index.html", location.href);
  dash.search = new URLSearchParams({ rpc: RPC, guard: state.addrs.guard }).toString();
  const spent = state.startLamports !== null ? state.startLamports - (await balance()) : null;
  const markBtn = el("button", { className: "button quiet-button", type: "button" }, "Mark today now");
  const markStatus = el("p", { className: "note", "aria-live": "polite" });
  markBtn.addEventListener("click", () => markToday(markBtn, markStatus));
  const loss = g.dailyLoss?.max ? `${(Number(g.dailyLoss.max) / 1e6).toLocaleString("en-US")} dUSDT` : null;
  $("done").replaceChildren(...[
    el("div", { className: "code-head" }, el("span", { className: "field-name" }, "MCP settings"), copyButton(() => cfg)),
    el("pre", { className: "code" }, cfg),
    el("p", { className: "note" }, `Replace the two /path/to/ parts with where you cloned the repo and where you saved ${state.createdHere ? agentFile : "the agent's key file"}. Run npm ci in the repo's mcp folder once.`),
    el("p", {}, el("a", { className: "button", href: dash.toString() }, "Open your guard's dashboard")),
    el("dl", { className: "facts" },
      el("dt", {}, "Guard"), el("dd", {}, explorer("address", state.addrs.guard)),
      el("dt", {}, "Agent"), el("dd", {}, explorer("address", g.agent)),
      el("dt", {}, ownerKeeps ? "Owner and keeper" : "Owner"), el("dd", {}, explorer("address", state.owner)),
      ownerKeeps ? null : [el("dt", {}, "Keeper"), el("dd", {}, keeper === DEFAULT_KEY ? "none set" : explorer("address", keeper))],
      spent !== null && spent > 0n ? [el("dt", {}, "Spent on this page"), el("dd", {}, `${sol(spent)} devnet SOL (account rent, fees, and the agent's fee money)`)] : null,
    ),
    state.txs.length ? el("ul", { className: "tx-list" }, state.txs.map((t) => el("li", {}, `${t.label}: `, explorer("tx", t.sig, `${t.sig.slice(0, 10)}...`)))) : null,
    el("h3", {}, "The daily loss brake needs a daily mark"),
    el("p", { className: "note" }, !loss ? "The daily loss brake is off for this guard."
      : ownerKeeps ? `The brake (${loss} a day) measures loss from a mark taken each UTC day. Your wallet is the keeper, so the marks are yours to make: press the button below in the first hour after 00:00 UTC, or at any time to restart the count from your equity now. Without fresh marks the brake counts loss from the highest equity it has seen since your last mark. To mark automatically, set a separate keeper key from the repo (client.setKeeper) and run scripts/keeper.mjs with it.`
      : `The brake (${loss} a day) is marked each UTC day by the keeper above (scripts/keeper.mjs). As the owner you can also restart the count from your equity now at any time.`),
    loss ? markBtn : null,
    markStatus,
  ].filter((c) => c !== null && c !== undefined));
}

async function markToday(btn, status) {
  btn.disabled = true;
  try {
    status.textContent = "Check your wallet and approve...";
    const user = await account(state.addrs.velocityUser);
    const markets = activeMarkets(user?.data);
    const perpAddrs = await Promise.all(markets.map(perpMarketAddress));
    const infos = await accounts([state.addrs.spot0, ...perpAddrs]);
    if (infos.some((x) => !x)) throw new Error("a Velocity market account is missing");
    const remaining = pricingAccounts(state.addrs.spot0, infos[0].data, perpAddrs.map((address, i) => ({ address, data: infos[i + 1].data })));
    const sig = await signAndSend([checkpointIx(state.owner, state.addrs, remaining)], "Daily mark");
    status.replaceChildren("Marked. ", explorer("tx", sig, "View the transaction"));
  } catch (e) {
    status.textContent = explain(e);
  }
  btn.disabled = false;
}

// ---------- step gating ----------

function update() {
  const connected = !!state.owner;
  const funded = state.deposits > 0n;
  $("account-go").disabled = !connected || funded || state.guardExists;
  $("account-go").hidden = funded || state.guardExists;
  const problems = checkPlain(readPlain());
  $("limits-problems").replaceChildren(...problems.map((p) => el("li", { className: "err" }, p)));
  const agent = agentChoice();
  if (state.guardExists) say("agent-status", `Your guard's agent: ${state.agent?.publicKey ?? "none (revoked)"}`, "ok");
  else say("agent-status", agent.ok ? `Agent key ready: ${agent.key}` : agent.why, agent.ok ? "ok" : undefined);
  const ready = connected && funded && !state.guardExists && !problems.length && agent.ok;
  $("guard-go").disabled = !ready;
  $("guard-go").hidden = state.guardExists;
  if (!state.guardExists && connected) {
    const why = !funded ? "Open the Velocity account first (step 2)." : problems.length ? "Fix the limits above." : !agent.ok ? agent.why : "Ready.";
    if (!$("guard-status").classList.contains("err") || ready) say("guard-status", why);
  }
  for (const [id, done] of [["step-wallet", connected], ["step-account", funded || state.guardExists], ["step-limits", state.guardExists], ["step-agent", state.guardExists], ["step-guard", state.guardExists], ["step-done", state.guardExists]]) {
    $(id).classList.toggle("done", done);
  }
}

if (!RPC) {
  $("rpc-warn").hidden = false;
  $("rpc-warn").textContent = "This page only sends to Solana's public devnet RPC or a local validator. Remove the rpc parameter from the address.";
  for (const b of document.querySelectorAll("button:not(#theme)")) b.disabled = true;
} else {
  applyPreset("balanced");
  makeAgent();
}
