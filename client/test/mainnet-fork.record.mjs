#!/usr/bin/env node
// Records ONE unbroken 1080p take of the mainnet-fork run: on the left the agent's words, its orders, the guard's
// verdicts and the fills, streamed line by line from `node demo/mainnet-fork.mjs run ...` as it runs; on the right the
// dashboard pointed at the fork's RPC, refreshing every 3 s. Frames are screenshots taken in a loop and timed by their
// capture time (as in setup-page.record.mjs), then encoded at a constant 30 fps.
//   node client/test/mainnet-fork.record.mjs <out.mp4> <transcript.txt> -- run --turns 8 [--replay file.jsonl]
// Needs the fork (scripts/surfpool-mainnet.sh start) and out/mainnet-fork-demo.json (node demo/mainnet-fork.mjs setup).
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { serveDashboard } from "./test-wallet.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const [out = "mainnet-fork-live.mp4", transcript = "mainnet-fork-live.txt"] = process.argv.slice(2);
const runArgs = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : ["run", "--turns", "8"];
const demo = JSON.parse(readFileSync(join(ROOT, "out/mainnet-fork-demo.json"), "utf8"));
const { base, close } = await serveDashboard();
const dashUrl = `${base}/index.html?${new URLSearchParams({ rpc: demo.rpc, guard: demo.guard })}`;
const started = new Date().toISOString().slice(0, 16).replace("T", " ");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0d1117; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; }
  .banner { position: absolute; left: 0; top: 0; width: 1920px; height: 74px; box-sizing: border-box; padding: 10px 24px; background: #161b22; color: #e6edf3; border-bottom: 2px solid #f0b72f; }
  .banner b { color: #f0b72f; }
  .banner .l1 { font-size: 22px; font-weight: 650; }
  .banner .l2 { font-size: 18px; color: #c9d1d9; margin-top: 3px; }
  .term { position: absolute; left: 0; top: 74px; width: 1030px; height: 1006px; box-sizing: border-box; padding: 16px 20px; overflow: hidden;
    font-family: Menlo, "SF Mono", Monaco, monospace; font-size: 23px; line-height: 1.34; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
  .dash { position: absolute; left: 1030px; top: 74px; width: 890px; height: 1006px; border: 0; background: #f4f4f2; }
  .prompt { color: #7ee787; } .head { color: #8b949e; } .turn { color: #f0b72f; font-weight: 700; margin-top: 4px; }
  .agent { color: #e6edf3; } .call { color: #a5d6ff; } .refused { color: #ff7b72; font-weight: 700; } .accepted { color: #7ee787; font-weight: 700; }
  .guardinfo { color: #c9d1d9; } .fill { color: #79c0ff; font-weight: 700; } .now { color: #d2a8ff; } .summary { color: #f0f6fc; font-weight: 700; } .err { color: #ffa198; }
</style></head><body>
<div class="banner"><div class="l1"><b>LOCAL FORK OF SOLANA MAINNET</b> (surfpool 1.7.0), ${started} UTC. Velocity's real mainnet program and state. Nothing is sent to mainnet.</div>
<div class="l2">SOL oracle streamed live from mainnet (no script sets a price). Fills: Velocity's own matching against copies of real mainnet orders or its AMM. Guardrail: the devnet build, loaded into this fork.</div></div>
<div class="term" id="term"></div>
<iframe class="dash" id="dash" src="${dashUrl}"></iframe>
<script>
  const term = document.getElementById("term");
  window.addLine = (line, kind) => {
    const div = document.createElement("div");
    div.textContent = line.length ? line : " ";
    let cls = kind || "plain";
    if (!kind) {
      if (/^turn \\d+/.test(line)) cls = "turn";
      else if (/^\\s+agent:/.test(line)) cls = "agent";
      else if (/^\\s+call:/.test(line)) cls = "call";
      else if (/^\\s+guard: REFUSED/.test(line)) cls = "refused";
      else if (/^\\s+guard: ACCEPTED/.test(line)) cls = "accepted";
      else if (/^\\s+guard:/.test(line)) cls = "guardinfo";
      else if (/^\\s+fill:/.test(line)) cls = "fill";
      else if (/^\\s+now:/.test(line)) cls = "now";
      else if (/^summary:/.test(line)) cls = "summary";
      else if (/^(LOCAL FORK|SOL price|Fills|the order|Agent|Mandate|Guard|log:)/.test(line)) cls = "head";
    }
    div.className = cls;
    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
  };
</script></body></html>`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "light" });
const page = await context.newPage();
await page.setContent(html);
// The dashboard: wait for its first live read, then show its live section at 110% (the hero and recorded fills card
// above it belong to the devnet runs).
let dash = null;
for (let i = 0; i < 200 && !dash; i++) { dash = page.frames().find((f) => f.url().startsWith(base)) ?? null; if (!dash) await page.waitForTimeout(100); }
if (!dash) throw new Error("the dashboard frame did not load");
await dash.waitForFunction(() => /Live read/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 60_000 });
await dash.evaluate(() => { document.documentElement.style.zoom = "1.1"; document.getElementById("live-title").scrollIntoView({ block: "start" }); });

const frameDir = mkdtempSync(join(tmpdir(), "guardrail-fork-frames-"));
const frames = [];
let recording = true;
const recorder = (async () => {
  while (recording) {
    try { const t = Date.now(); const buf = await page.screenshot({ type: "jpeg", quality: 90 }); frames.push({ t, buf }); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
})();
const lines = [];
const show = async (line, kind) => { lines.push(line); await page.evaluate(([l, k]) => window.addLine(l, k), [line, kind ?? null]); };
let code = null;
try {
  await show(`$ node demo/mainnet-fork.mjs ${runArgs.join(" ")}`, "prompt");
  await page.waitForTimeout(2500);
  const child = spawn(process.execPath, [join(ROOT, "demo/mainnet-fork.mjs"), ...runArgs], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const queue = [];
  let draining = Promise.resolve();
  const push = (l, kind) => { queue.push([l, kind]); draining = draining.then(async () => { const [x, k] = queue.shift(); await show(x, k); }); };
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.on("data", (d) => { for (const l of String(d).split("\n").filter(Boolean)) push(l, "err"); });
  code = await new Promise((r) => child.on("close", r));
  if (buf) push(buf);
  await draining;
  // Hold the end: the dashboard refreshes every 3 s and shows the final counters and position.
  await page.waitForTimeout(7000);
} finally {
  recording = false;
  await recorder;
  await context.close();
  await browser.close();
  close();
}
writeFileSync(transcript, lines.join("\n") + "\n");
const list = frames.map((f, i) => {
  const name = join(frameDir, `${String(i).padStart(5, "0")}.jpg`);
  writeFileSync(name, f.buf);
  const dur = i + 1 < frames.length ? (frames[i + 1].t - f.t) / 1000 : 2;
  return `file '${name}'\nduration ${dur.toFixed(3)}`;
});
writeFileSync(join(frameDir, "list.txt"), `ffconcat version 1.0\n${list.join("\n")}\nfile '${join(frameDir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'\n`);
// Constant 30 fps (ffmpeg 8 replaced -vsync cfr with -fps_mode cfr), standard yuv420p in TV range (the frames are full-range JPEGs).
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frameDir, "list.txt"), "-vf", "fps=30,scale=1920:1080:in_range=pc:out_range=tv,format=yuv420p", "-fps_mode", "cfr", "-r", "30", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", out]);
rmSync(frameDir, { recursive: true, force: true });
console.log(`${frames.length} frames over ${((frames.at(-1).t - frames[0].t) / 1000).toFixed(1)} s; run exit code ${code}`);
console.log(`video: ${out}; transcript: ${transcript}; guard ${demo.guard}`);
