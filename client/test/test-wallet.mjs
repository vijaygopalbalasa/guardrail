// Test-only helpers for the setup page: a static server for dashboard/ and a Wallet Standard test wallet that signs
// with a given keypair. Used by setup-page.e2e.mjs and setup-page.record.mjs; never loaded by the page itself.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = fileURLToPath(new URL("../../dashboard/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** Serves dashboard/ on a free local port; returns { base, close }. */
export async function serveDashboard() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(DASH, path === "/" ? "index.html" : path);
    if (!file.startsWith(DASH)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file)); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** The test wallet: Wallet Standard features standard:connect and solana:signTransaction, signing with `owner`. */
export async function injectTestWallet(page, owner) {
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

}
