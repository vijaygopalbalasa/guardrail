#!/usr/bin/env node
// Records the setup page flow on devnet as a 1080p video for the demo: connect, open the Velocity account, pick the
// Cautious preset, download the agent key, create the guard, copy the MCP settings. Same throwaway test wallet as
// setup-page.e2e.mjs (injected here only). Costs about 0.06 devnet SOL plus the 0.1 SOL funding of the throwaway owner.
// Frames are full-page screenshots taken in a loop and timed by their capture time (the browser's own screencast tears
// while the page scrolls), assembled into the mp4 with ffmpeg.
//   node client/test/setup-page.record.mjs <out.mp4>
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { chromium } from "playwright-core";
import { key, fund } from "./velocity-setup.mjs";
import { serveDashboard, injectTestWallet } from "./test-wallet.mjs";

const out = process.argv[2] ?? "setup.mp4";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const owner = Keypair.generate();
await fund(conn, key("dev"), owner.publicKey, 0.1 * LAMPORTS_PER_SOL);
const { base, close } = await serveDashboard();
const frameDir = mkdtempSync(join(tmpdir(), "guardrail-frames-"));
// Full Chromium (CHROME_PATH) renders the screencast without the torn frames the headless shell gives while scrolling.
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const size = { width: 1920, height: 1080 };
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: "light", acceptDownloads: true });
const page = await context.newPage();
await injectTestWallet(page, owner);
// The page at 150% (as a viewer zooms in), so the text reads at video size while staying sharp.
await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "1.5"; }));
// A visible click marker for the video (the recording has no cursor): the pressed control rings briefly.
await page.addInitScript(() => {
  addEventListener("mousedown", (e) => {
    const el = e.target.closest("button, a, label") ?? e.target;
    el.animate([{ boxShadow: "0 0 0 0 rgba(42,120,214,.7)" }, { boxShadow: "0 0 0 14px rgba(42,120,214,0)" }], { duration: 700 });
  }, true);
});
const pause = (ms) => page.waitForTimeout(ms);
const show = async (sel) => { await page.$eval(sel, (el) => el.scrollIntoView({ behavior: "smooth", block: "center" })); await pause(1200); };
const click = async (sel) => { const b = await page.$(sel); const box = await b.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pause(300); await page.mouse.down(); await page.mouse.up(); };
const frames = [];
let recording = true;
const recorder = (async () => {
  while (recording) {
    try { const t = Date.now(); const buf = await page.screenshot({ type: "jpeg", quality: 92 }); frames.push({ t, buf }); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
})();
try {
  await page.goto(`${base}/setup.html`);
  await pause(2500);
  await click("#wallets button");
  await page.waitForFunction(() => document.getElementById("wallet-status").textContent.includes("devnet SOL"));
  await pause(1500);
  await show("#step-account");
  await click("#account-go");
  await page.waitForFunction(() => /deposited|refused|failed/.test(document.getElementById("account-status").textContent), null, { timeout: 120_000 });
  await pause(1800);
  await show("#step-limits .presets");
  await click("button[data-preset=cautious]");
  await pause(2500);
  await show("#step-agent");
  await pause(800);
  const [dl] = await Promise.all([page.waitForEvent("download"), click("#agent-download")]);
  await dl.path();
  await pause(1800);
  await show("#step-guard");
  await click("#guard-go");
  await page.waitForFunction(() => /live|refused|failed/.test(document.getElementById("guard-status").textContent), null, { timeout: 120_000 });
  if (!(await page.textContent("#guard-status")).includes("The guard is live")) throw new Error(await page.textContent("#guard-status"));
  await pause(1800);
  await show("#done .code-head");
  await pause(800);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await click("#done .code-head button");
  await pause(3500);
  await show("#done a.button");
  await pause(2500);
} finally {
  recording = false;
  await recorder;
  await context.close();
  await browser.close();
  close();
}
// Each frame lasts until the next one was taken; the last one is held for 2 s.
const list = frames.map((f, i) => {
  const name = join(frameDir, `${String(i).padStart(5, "0")}.jpg`);
  writeFileSync(name, f.buf);
  const dur = i + 1 < frames.length ? (frames[i + 1].t - f.t) / 1000 : 2;
  return `file '${name}'\nduration ${dur.toFixed(3)}`;
});
writeFileSync(join(frameDir, "list.txt"), `ffconcat version 1.0\n${list.join("\n")}\nfile '${join(frameDir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'\n`);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frameDir, "list.txt"), "-vf", "fps=30,scale=1920:1080,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", out]);
rmSync(frameDir, { recursive: true, force: true });
console.log(`${frames.length} frames over ${((frames.at(-1).t - frames[0].t) / 1000).toFixed(1)} s`);
console.log(`video: ${out}; owner ${owner.publicKey.toBase58()}`);
