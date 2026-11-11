// Runs the official fiber-js node in headless Chrome (the deployed spike page)
// and exposes it as a JSON-RPC endpoint on 127.0.0.1, so scripts written for a
// native FNN payer, such as meterd's `npm run e2e`, drive the browser node.
//
//   PROFILE_DIR=/path/to/profile npm run bridge
//   # then, elsewhere: PAYER_RPC=http://127.0.0.1:8247 BOX_P2P_ADDR=<wss addr> npm run e2e
//
// PROFILE_DIR keeps the browser's keys and channel state between runs, as a
// real user's browser would. Uses the locally installed Google Chrome.
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const url = process.env.URL ?? "https://162-35-126-18.sslip.io/spike.html";
const port = Number(process.env.BRIDGE_PORT ?? 8247);
const profileDir = process.env.PROFILE_DIR;
if (!profileDir) throw new Error("set PROFILE_DIR so keys and channels persist");

const context = await chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: true });
const page = context.pages()[0] ?? (await context.newPage());
page.on("console", (m) => console.log(`[browser] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => globalThis.fiber !== undefined || globalThis.spike?.stage === "failed", undefined, {
  timeout: 90_000,
  polling: 250,
});
const { stage, error, address, pubkey } = await page.evaluate(() => globalThis.spike);
if (stage === "failed") throw new Error(`browser node failed: ${error}`);
console.log(`browser node ${pubkey}`);
console.log(`browser address ${address}`);

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  let id = null;
  try {
    const rpc = JSON.parse(body);
    id = rpc.id ?? null;
    const result = await page.evaluate(
      ([method, params]) => globalThis.fiber.invokeCommand(method, params),
      [rpc.method, rpc.params ?? []],
    );
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
  } catch (e) {
    const message = String(e?.message ?? e).replace(/^page\.evaluate: (Error: )?/, "");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  }
}).listen(port, "127.0.0.1", () => console.log(`bridge listening on http://127.0.0.1:${port}`));
