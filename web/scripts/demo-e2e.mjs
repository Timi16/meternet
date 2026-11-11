// Plays the Meter page like a visitor, in Chrome: waits for the wallet and an
// existing channel, picks a ride, lets it pay, presses STOP PAYING, and waits
// for the cut. Saves screenshots and prints what the page reported.
//
//   PROFILE_DIR=/path/with/a/funded/channel OUT=/tmp/shots node scripts/demo-e2e.mjs
//
// PROFILE_DIR must hold a browser whose node already has a ready channel to
// the MeterNet node (e.g. the one browser-bridge.mjs used). KIND=download
// rides the download instead of the video. HEADED=1 shows the window.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "https://162-35-126-18.sslip.io";
const PROFILE_DIR = process.env.PROFILE_DIR;
const OUT = process.env.OUT ?? "shots";
const KIND = process.env.KIND ?? "video";
const PAY_FOR_MB = Number(process.env.PAY_FOR_MB ?? 6);
if (!PROFILE_DIR) throw new Error("set PROFILE_DIR");
mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: !process.env.HEADED,
  viewport: { width: 1366, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const shot = async (name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

try {
  await page.goto(BASE + "/");
  await page.waitForTimeout(1500);
  await shot("1-boarding");
  await page.waitForSelector("#ride:not(.hidden)", { timeout: 120_000 });
  console.log(`${at()} channel ready: ${await page.locator("#channel-detail").innerText()}`);
  await shot("2-ready");

  await page.click(`.choice[data-kind="${KIND}"]`);
  console.log(`${at()} ride started (${KIND})`);
  await page.waitForFunction(
    (mb) => Number(document.querySelector("#led-used")?.getAttribute("aria-label") ?? 0) >= mb,
    PAY_FOR_MB,
    { timeout: 180_000, polling: 500 },
  );
  console.log(`${at()} meter at ${PAY_FOR_MB} MB: ${await page.locator("#message").innerText()}`);
  await shot("3-riding");

  await page.click("#stop");
  console.log(`${at()} pressed STOP PAYING`);
  await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("cut in"), undefined, {
    timeout: 60_000,
    polling: 250,
  });
  await shot("4-grace");
  console.log(`${at()} grace: ${await page.locator("#message").innerText()}`);

  await page.waitForSelector("#result:not(.hidden)", { timeout: 60_000 });
  console.log(`${at()} ${await page.locator("#result-big").innerText()} | ${await page.locator("#result-verdict").innerText()}`);
  console.log(`${at()} ${await page.locator("#result-detail").innerText()}`);
  await page.waitForTimeout(800);
  await shot("5-cut");

  const receipt = await page.locator("#receipt").innerText();
  console.log(`receipt:\n${receipt}`);

  await page.goto(BASE + "/dashboard.html");
  await page.waitForTimeout(2500);
  await shot("6-board");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/");
  await page.waitForSelector("#ride:not(.hidden)", { timeout: 120_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "7-mobile.png"), fullPage: false });
} finally {
  await context.close();
}
