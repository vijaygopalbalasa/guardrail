#!/usr/bin/env node
// End to end on Solana devnet: dashboard/setup.html in a headless browser, driven like an owner would, with a
// throwaway wallet. The wallet is a Wallet Standard test wallet injected by THIS script only (setup.html has no test
// hook); it signs with a fresh keypair funded from keys/dev.json. Afterwards the chain is checked and the downloaded
// agent key places orders through the guard. Costs about 0.06 devnet SOL.
//   node client/test/setup-page.e2e.mjs            (from the repo root; needs keys/dev.json with devnet SOL)
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { chromium } from "playwright-core";
import { GuardrailClient, toBase } from "../dist/index.js";
import { key, fund } from "./velocity-setup.mjs";
import { PRESETS, toLimits, dailyLossUnits } from "../../dashboard/setup-tx.js";
import { decodeGuard as decodeGuardView } from "../../dashboard/guard-view.js";

const RPC = "https://api.devnet.solana.com";
const DASH = fileURLToPath(new URL("../../dashboard/", import.meta.url));
const conn = new Connection(RPC, "confirmed");
const client = new GuardrailClient(conn);
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`ok  ${what}`); };

// A static server for dashboard/ only.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(DASH, path === "/" ? "index.html" : path);
  if (!file.startsWith(DASH)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const owner = Keypair.generate();
const FUND = 0.1 * LAMPORTS_PER_SOL;
console.log(`owner ${owner.publicKey.toBase58()} (throwaway), funded with 0.1 devnet SOL from keys/dev.json`);
await fund(conn, key("dev"), owner.publicKey, FUND);

const downloads = mkdtempSync(join(tmpdir(), "guardrail-e2e-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  // The test wallet: Wallet Standard features standard:connect and solana:signTransaction, signing with the owner key.
  await page.addInitScript(({ secret, address }) => {
    const seed = Uint8Array.from(secret.slice(0, 32));
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
    const signingKey = crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const account = Object.freeze({ address, publicKey: Uint8Array.from(secret.slice(32)), chains: ["solana:devnet"], features: ["solana:signTransaction"] });
    const wallet = {
      version: "1.0.0", name: "Test wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:devnet"], accounts: [account],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "solana:signTransaction": {
          version: "1.0.0", supportedTransactionVersions: ["legacy"],
          signTransaction: (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
            const tx = Uint8Array.from(transaction);
            const n = tx[0];
            const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await signingKey, tx.subarray(1 + 64 * n)));
            tx.set(sig, 1); // the owner is the fee payer, so its slot is the first
            return { signedTransaction: tx };
          })),
        },
      },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  }, { secret: [...owner.secretKey], address: owner.publicKey.toBase58() });

  await page.goto(`${base}/setup.html`);
  await page.getByRole("button", { name: "Connect Test wallet" }).click();
  await page.waitForFunction(() => document.getElementById("wallet-status").textContent.includes("devnet SOL"));
  console.log(`page: ${await page.textContent("#wallet-status")}`);

  // 2. Velocity account with 1,000 dUSDT.
  await page.click("#account-go");
  await page.waitForFunction(() => /deposited|worth|refused|declined|Not enough|failed/.test(document.getElementById("account-status").textContent), null, { timeout: 120_000 });
  const acct = await page.textContent("#account-status");
  console.log(`page: ${acct}`);
  check(acct.includes("deposited 1,000 test dUSDT"), "step 2 opened the Velocity account with 1,000 dUSDT");

  // 3. Cautious preset, then one change by hand.
  await page.click("button[data-preset=cautious]");
  await page.fill("#f-dailyLossUsd", "25");
  const plain = { ...PRESETS.cautious, dailyLossUsd: 25 };
  check(await page.isDisabled("#guard-go"), "create stays disabled until the agent key is downloaded");

  // 4. The agent key: download it.
  await page.waitForFunction(() => !document.getElementById("agent-download").disabled);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#agent-download")]);
  const keyFile = join(downloads, dl.suggestedFilename());
  await dl.saveAs(keyFile);
  const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8"))));
  check((await page.textContent("#agent-pub")).includes(agent.publicKey.toBase58()), `downloaded ${dl.suggestedFilename()} holds the agent key the page shows`);

  // 5. The guard.
  await page.click("#guard-go");
  await page.waitForFunction(() => /live|refused|declined|Not enough|failed/.test(document.getElementById("guard-status").textContent), null, { timeout: 120_000 });
  const gs = await page.textContent("#guard-status");
  console.log(`page: ${gs}`);
  check(gs.includes("The guard is live"), "step 5 created the guard");
  await page.waitForSelector("#done pre");
  const cfg = JSON.parse(await page.textContent("#done pre"));
  const dash = await page.getAttribute("#done a.button", "href");

  // On chain.
  const { guard, velocityUser } = client.guardFor(owner.publicKey);
  const g = await client.getGuard(owner.publicKey);
  const user = (await conn.getAccountInfo(velocityUser, "confirmed")).data;
  check(new PublicKey(user.subarray(40, 72)).equals(guard), "the Velocity account's delegate is the guard");
  check(g.agent.equals(agent.publicKey), "the guard's agent is the downloaded key");
  const want = toLimits(plain);
  check(g.limits.maxOrderBase === want.maxOrderBase && g.limits.markets[0].maxExposureBase === want.markets[0].maxExposureBase
    && g.limits.dailyNotionalCap === want.dailyNotionalCap && g.limits.maxLeverageBps === want.maxLeverageBps
    && g.limits.priceBandBps === want.priceBandBps && g.limits.allowedOrderTypes === want.allowedOrderTypes, "the limits are the Cautious preset as typed");
  const view = decodeGuardView(new Uint8Array((await conn.getAccountInfo(guard, "confirmed")).data));
  check(view.dailyLoss?.keeper === owner.publicKey.toBase58(), "the keeper is the owner");
  check(g.dailyLoss?.max === dailyLossUnits(plain), "the daily loss cap is 25 dUSDT");
  check(await conn.getBalance(agent.publicKey) === 20_000_000, "the agent got 0.02 SOL for fees");
  check(cfg.mcpServers.guardrail.env.GUARDRAIL_OWNER === owner.publicKey.toBase58() && cfg.mcpServers.guardrail.env.GUARDRAIL_RPC_URL === RPC, "the MCP config names this owner and devnet");
  check(dash.includes(`guard=${guard.toBase58()}`), "the dashboard link opens this guard");

  // The downloaded key trades through the guard.
  const big = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(2), orderType: "oracle", oracleOffset: -100_000n } });
  console.log(`order 2 SOL: accepted=${big.accepted} ${big.ruleName ?? ""} tx ${big.signature}`);
  check(!big.accepted && big.rule === 1, "a 2 SOL order is refused on chain by G1 (Cautious: 1 SOL per order)");
  const small = await client.placeOrder({ agent, owner: owner.publicKey, order: { side: "long", size: toBase(0.5), orderType: "oracle", oracleOffset: -100_000n } });
  console.log(`order 0.5 SOL: accepted=${small.accepted} ${small.ruleName ?? ""} tx ${small.signature}`);
  check(small.accepted, "a 0.5 SOL oracle order inside the limits is accepted and sent to Velocity");

  // The owner's daily mark from the page.
  const before = Date.now();
  await page.click("#done button:has-text('Mark today now')");
  const markText = () => page.$$eval("#done p.note", (ps) => ps.map((p) => p.textContent).join(" | "));
  try {
    await page.waitForFunction(() => { const t = [...document.querySelectorAll("#done p.note")].map((p) => p.textContent).join(" "); return !t.includes("Check your wallet") && /Marked|refused|failed|declined|confirmed|missing|Error|error/.test(t); }, null, { timeout: 150_000 });
  } catch (e) { console.log(`mark status after ${Math.round((Date.now() - before) / 1000)} s: ${await markText()}`); throw e; }
  const marked = await markText();
  console.log(`page: ${marked.split(" | ").pop()}`);
  check(marked.includes("Marked."), "Mark today now sends the owner's checkpoint");

  const spent = FUND - (await conn.getBalance(owner.publicKey));
  console.log(`page summary: ${(await page.textContent("#done dl")).replace(/\s+/g, " ")}`);
  console.log(`COST: ${(spent / LAMPORTS_PER_SOL).toFixed(6)} SOL from the owner wallet for the whole page flow plus one mark (includes the agent's 0.02 SOL; the agent paid its own order fees)`);
  console.log(`owner ${owner.publicKey.toBase58()} guard ${guard.toBase58()} agent ${agent.publicKey.toBase58()}`);
  console.log(`dashboard ${dash}`);
} finally {
  await browser.close();
  server.close();
  rmSync(downloads, { recursive: true, force: true });
}
