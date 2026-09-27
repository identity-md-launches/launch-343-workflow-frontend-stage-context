import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "dist",
      new URL(req.url, "http://localhost").pathname.replace(
        /^\/preview\//,
        "",
      ) || "index.html",
    );
    if (!path.startsWith(resolve(root, "dist") + "/")) throw Error("Bad path");
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(path)] || "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [],
  requests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("requestfailed", (r) =>
  requests.push({ url: r.url(), error: r.failure()?.errorText }),
);
const report = {
  date: new Date().toISOString(),
  mode: "Real public RPC, disconnected wallet, production export at /preview/; read-only, no transactions",
  result: "UNAVAILABLE",
  errors,
  failedRequests: requests,
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
  await page
    .getByText(/Verified ABI & contract code/)
    .waitFor({ timeout: 45000 });
  report.result = "PASS";
  report.chainState = await page.locator(".chain-note").innerText();
  report.stats = await page.locator(".stats").innerText();
  report.overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  await page.screenshot({
    path: resolve(root, "docs/evidence/live-desktop.png"),
    fullPage: true,
  });
} catch (e) {
  report.error = e.message;
  report.visibleStatus = await page.locator("body").innerText();
  process.exitCode = 1;
} finally {
  await writeFile(
    resolve(root, "docs/evidence/live-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
}
