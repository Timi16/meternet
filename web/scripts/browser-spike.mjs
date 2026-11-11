// Opens the deployed spike page in a fresh, headless Chrome profile and reports
// whether the browser node reached the MeterNet FNN over wss.
//
//   npm run spike                      # https://162-35-126-18.sslip.io/spike.html
//   URL=https://host/spike.html npm run spike
//
// Uses the locally installed Google Chrome (playwright-core downloads nothing).
import { chromium } from "playwright-core";

const url = process.env.URL ?? "https://162-35-126-18.sslip.io/spike.html";
const timeoutMs = 90_000;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[browser ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(
    () => ["connected", "failed"].includes(globalThis.spike?.stage),
    undefined,
    { timeout: timeoutMs, polling: 500 },
  );
  const result = await page.evaluate(() => globalThis.spike);
  console.log(await page.locator("#log").innerText());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.stage === "connected" ? 0 : 1;
} finally {
  await browser.close();
}
