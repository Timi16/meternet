// Bundles the browser pages into public/dist. The MeterNet node's address is
// baked in at build time; override with BOX_ADDR / BOX_PUBKEY / CKB_RPC.
//
//   demo.js   the Meter (index.html); fiber-js and hls.js load as separate
//             chunks after the page is shown, so it appears at once
//   board.js  the Board (dashboard.html); no wallet, small
//   spike.js  the connection test (spike.html)
import * as esbuild from "esbuild";

const env = {
  BOX_ADDR:
    process.env.BOX_ADDR ??
    "/dns4/fiber.162-35-126-18.sslip.io/tcp/443/wss/p2p/QmSzv8g9Q62HQv8CuyoygtS7K5vHCKxHjrL4iLWkBtzfNq",
  BOX_PUBKEY: process.env.BOX_PUBKEY ?? "03186544ca086b08f08970bdc77a8f894769a1599213c3c73cc070a03bd7b24cc5",
  CKB_RPC: process.env.CKB_RPC ?? "https://testnet.ckbapp.dev/",
};

await esbuild.build({
  entryPoints: ["src/demo.ts", "src/board.ts", "src/spike.ts"],
  outdir: "public/dist",
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  chunkNames: "chunks/[name]-[hash]",
  define: Object.fromEntries(Object.entries(env).map(([k, v]) => [`__${k}__`, JSON.stringify(v)])),
  logLevel: "info",
});
