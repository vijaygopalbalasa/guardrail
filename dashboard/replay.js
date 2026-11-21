import { renderReplayRun, renderError } from "./render.js?v=2";

const $ = (id) => document.getElementById(id);
let data = null;
const q = new URLSearchParams(location.search);
let i = Math.max(0, Number(q.get("step") ?? 1) - 1) || 0;
let timer = null;

function draw() {
  const right = data.runs.find((r) => r.id === $("right").value) ?? data.runs[1];
  renderReplayRun(document, $("left"), data.runs[0], i, data.collateral);
  renderReplayRun(document, $("rightp"), right, i, data.collateral);
  $("step").value = String(i);
  $("stepn").textContent = `step ${i + 1} of ${data.runs[0].steps.length}`;
}

function play() {
  if (timer) { clearInterval(timer); timer = null; $("play").textContent = "Play"; return; }
  if (i >= data.runs[0].steps.length - 1) i = 0;
  $("play").textContent = "Pause";
  timer = setInterval(() => {
    if (i >= data.runs[0].steps.length - 1) { play(); return; }
    i += 1;
    draw();
  }, 1200);
}

try {
  data = await (await fetch("./replay.json")).json();
  $("label").textContent = String(data.label);
  $("agent").textContent = String(data.agent);
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
  draw();
} catch (e) {
  renderError(document, $("left"), `could not load replay.json: ${e.message}`);
}
