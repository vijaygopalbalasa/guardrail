import { renderReplayRun, renderPriceChart, renderError, runCap } from "./render.js?v=11";
import { themeToggle } from "./theme.js?v=4";

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
let data = null;
let i = Math.max(0, Number(q.get("step") ?? 1) - 1) || 0;
let timer = null;
const charts = new Map();

const refusedTotal = (run) => Object.values(run.summary.refusedBy ?? {}).reduce((a, b) => a + Number(b), 0);

function hero(right) {
  const un = data.runs[0].summary, gu = right.summary;
  const n = data.runs[0].steps.filter((x) => !x.final).length;
  $("hero").textContent = `The agent tried to double a losing long ${n} times. Guardrail refused ${refusedTotal(right)} orders and held it to ${Number(gu.maxPosition).toLocaleString("en-US", { maximumFractionDigits: 1 })} SOL. Worst loss ${Number(gu.worstLossPct).toFixed(1)}% vs ${Number(un.worstLossPct).toFixed(1)}% unguarded.`;
}

/** Hover on any chart shows that step; a click jumps the replay there. */
function wire(box, chart) {
  charts.set(box, chart);
  if (box.dataset.wired) return;
  box.dataset.wired = "1";
  const at = (ev) => {
    const c = charts.get(box);
    const r = box.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * c.width;
    const j = Math.round(((sx - c.L) / c.pw) * (c.n - 1));
    return { c, j: Math.max(0, Math.min(c.n - 1, j)), r };
  };
  box.addEventListener("pointermove", (ev) => {
    const { c, j, r } = at(ev);
    const tip = box.querySelector(".tip");
    if (!tip) return;
    tip.textContent = c.tip(j);
    tip.style.display = "block";
    tip.style.left = `${(c.x(j) / c.width) * r.width}px`;
    tip.style.top = `${ev.clientY - r.top}px`;
  });
  box.addEventListener("pointerleave", () => { const tip = box.querySelector(".tip"); if (tip) tip.style.display = "none"; });
  box.addEventListener("click", (ev) => { i = at(ev).j; draw(); });
}

function draw() {
  const right = data.runs.find((r) => r.id === $("right").value) ?? data.runs[1];
  const pair = [data.runs[0], right];
  const peak = Math.max(...pair.flatMap((r) => r.steps.map((x) => Number(x.position) + Number(x.openBids))), ...pair.map((r) => runCap(r) ?? 0));
  const maxY = Math.ceil(peak / 10) * 10;
  const w = (el) => Math.max(280, Math.round(el.clientWidth || 520) - 36);
  hero(right);
  wire($("price"), renderPriceChart(document, $("price"), data.runs[0], i, Math.max(280, Math.round($("price").clientWidth || 900))));
  const a = renderReplayRun(document, $("left"), data.runs[0], i, data.collateral, { maxY, width: w($("left")), key: "un" });
  const b = renderReplayRun(document, $("rightp"), right, i, data.collateral, { maxY, width: w($("rightp")), key: "gu" });
  wire(a.chartBox, a.chart);
  wire(b.chartBox, b.chart);
  $("step").value = String(i);
  $("stepn").textContent = data.runs[0].steps[i].final ? "final mark" : `step ${i + 1} of ${data.runs[0].steps.filter((x) => !x.final).length}`;
}

function play() {
  if (timer) { clearInterval(timer); timer = null; $("play").textContent = "Play"; return; }
  if (i >= data.runs[0].steps.length - 1) i = 0;
  $("play").textContent = "Pause";
  timer = setInterval(() => {
    if (i >= data.runs[0].steps.length - 1) { play(); return; }
    i += 1;
    draw();
  }, 1100);
}

themeToggle($("theme"));
try {
  try { data = await (await fetch("./replay.json")).json(); }
  catch (e) { throw new Error(`Could not load replay.json (${e.message}). Serve this folder over http, for example: python3 -m http.server`); }
  $("label").textContent = String(data.label).replace(/^REPLAY:\s*/, "");
  $("agent").textContent = `The agent: ${String(data.agent)}`;
  $("step").max = String(data.runs[0].steps.length - 1);
  for (const r of data.runs.slice(1)) {
    const o = document.createElement("option");
    o.value = String(r.id);
    o.textContent = String(r.title);
    $("right").appendChild(o);
  }
  i = Math.min(i, data.runs[0].steps.length - 1);
  if (data.runs.some((r) => r.id === q.get("compare"))) $("right").value = q.get("compare");
  $("right").addEventListener("change", draw);
  $("step").addEventListener("input", () => { i = Number($("step").value); draw(); });
  $("play").addEventListener("click", play);
  let rs = null;
  window.addEventListener("resize", () => { clearTimeout(rs); rs = setTimeout(draw, 120); });
  draw();
  if (q.get("autoplay") === "1") play();
} catch (e) {
  renderError(document, $("left"), e.message);
}
