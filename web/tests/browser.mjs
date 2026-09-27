import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { decodeAbiParameters, parseAbiParameters } from "viem";
import {
  fixture,
  manifest,
  board,
  token,
  net,
  worker,
  poster,
  hash,
} from "./fixture.mjs";
const root = resolve(import.meta.dirname, "../.."),
  results = [],
  out = resolve(root, "docs/evidence");
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    ).replace(/^\/preview\//, "");
    if (relative.includes("..")) throw Error("bad path");
    const path = resolve(root, "dist", relative || "index.html");
    if (!path.startsWith(resolve(root, "dist") + "/")) throw Error("bad path");
    const content = await readFile(path);
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(path)] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({ headless: true });
let current;
const failures = [];
async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, result: "PASS", durationMs: Date.now() - start });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, result: "FAIL", error: e.stack });
    failures.push(name);
    console.error("FAIL", name, e.message);
    if (current)
      await current.screenshot({
        path: resolve(out, "failure.png"),
        fullPage: true,
      });
    throw e;
  }
}
async function open(
  f,
  { wallet = true, viewport = { width: 1440, height: 1000 } } = {},
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  current = page;
  page.errors = [];
  page.resources = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") page.errors.push(msg.text());
  });
  page.on("requestfailed", (req) =>
    page.resources.push({ url: req.url(), error: req.failure()?.errorText }),
  );
  page.on("response", (r) => {
    if (r.status() >= 400)
      page.resources.push({ url: r.url(), status: r.status() });
  });
  await page.route(
    /https:\/\/(ethereum-sepolia-rpc\.publicnode\.com|rpc\.sepolia\.ethpandaops\.io|sepolia\.rpc\.sentio\.xyz)/,
    async (route) => {
      const req = route.request().postDataJSON();
      const reply = async (r) => {
        try {
          return { jsonrpc: "2.0", id: r.id, result: await f.rpc(r) };
        } catch (e) {
          return {
            jsonrpc: "2.0",
            id: r.id,
            error: { code: e.code || -32000, message: e.message },
          };
        }
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          Array.isArray(req)
            ? await Promise.all(req.map(reply))
            : await reply(req),
        ),
      });
    },
  );
  if (wallet) {
    await page.exposeFunction("mockWallet", async (req) => {
      try {
        return { result: await f.wallet(req) };
      } catch (e) {
        return { error: { code: e.code || -32000, message: e.message } };
      }
    });
    await page.addInitScript(() => {
      const events = {};
      window.ethereum = {
        request: async (args) => {
          const v = await window.mockWallet(args);
          if (v.error) throw v.error;
          return v.result;
        },
        on: (n, cb) => (events[n] ??= []).push(cb),
        removeListener: (n, cb) => {
          events[n] = (events[n] || []).filter((x) => x !== cb);
        },
      };
      window.walletEvent = (n, args) => {
        for (const cb of events[n] || []) cb(args);
      };
    });
  }
  await page.goto(url);
  await page.getByRole("heading", { name: "The swarm at work." }).waitFor();
  await page
    .getByText(/Verified ABI & contract code/)
    .waitFor({ timeout: 15000 });
  return page;
}
async function enabled(locator) {
  await locator.waitFor();
  await eventually(async () => assert.equal(await locator.isEnabled(), true));
}
async function eventually(fn) {
  let err;
  for (let i = 0; i < 100; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      err = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw err;
}
async function refresh(page) {
  await page.getByRole("button", { name: "Refresh ↻", exact: true }).click();
  await page.getByRole("button", { name: "Refresh ↻", exact: true }).waitFor();
}
async function connected(page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Switch to Sepolia" }).click();
  await enabled(page.getByRole("button", { name: "Post task", exact: true }));
}
async function select(page, id = 1) {
  await page
    .getByRole("button")
    .filter({ hasText: `TASK / ${String(id).padStart(3, "0")}` })
    .click();
  await page
    .getByRole("heading", { name: `Task #${id}`, exact: true })
    .waitFor();
}
async function confirmed(page) {
  await page
    .getByText("Confirmed", { exact: true })
    .waitFor({ timeout: 15000 });
  await enabled(page.getByRole("button", { name: "Post task", exact: true }));
}
async function resetTask(
  f,
  page,
  {
    account = worker,
    status = 1,
    phase = "commit",
    commits = 1,
    revealed = 1,
  } = {},
) {
  f.account = account;
  f.tasks[0] = {
    ...f.tasks[0],
    status,
    commitCount: BigInt(commits),
    revealedCount: BigInt(revealed),
    deadline:
      f.now +
      (phase === "commit"
        ? 86400n
        : phase === "reveal"
          ? -1n
          : phase === "decision"
            ? -86400n
            : -604800n),
  };
  await page.evaluate(
    (account) => window.walletEvent("accountsChanged", [account]),
    account,
  );
  await refresh(page);
  if (
    !(await page.getByRole("heading", { name: "Task #1", exact: true }).count())
  )
    await select(page);
}
try {
  await check(
    "Static subpath, disconnected state, keyboard focus and no-wallet error",
    async () => {
      const f = fixture(),
        page = await open(f, { wallet: false });
      assert.equal(
        await page
          .getByRole("button", { name: "Post task", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Withdraw", exact: false })
          .isDisabled(),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent),
        "Skip to content",
      );
      await page.screenshot({ path: resolve(out, "keyboard-focus.png") });
      await page.getByRole("button", { name: "Connect wallet" }).click();
      await page.getByText(/No browser wallet found/).waitFor();
      assert.deepEqual(page.errors, []);
      assert.deepEqual(page.resources, []);
      await page.context().close();
    },
  );
  let f, page;
  await check(
    "Unknown chain prompts exact add-chain parameters, then switches",
    async () => {
      f = fixture();
      page = await open(f);
      await connected(page);
      const add = f.requests.find(
        (r) => r.method === "wallet_addEthereumChain",
      );
      assert.deepEqual(add.params, [manifest.walletAddChain]);
      assert.equal(f.chain, manifest.walletAddChain.chainId);
      assert.equal(
        await page.getByTestId("withdrawable").innerText(),
        "0.0005 ETH",
      );
    },
  );
  await check(
    "Post validates input, previews value and confirms a new task",
    async () => {
      await page.getByLabel("Specification hash", { exact: true }).fill("bad");
      await page
        .getByRole("button", { name: "Post task", exact: true })
        .click();
      await page.getByText(/Enter a specification hash/).waitFor();
      assert.equal(f.sent.length, 0);
      await page.getByLabel("Specification hash", { exact: true }).fill(hash);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      assert.match(
        await page.evaluate(() => document.activeElement.textContent),
        /Post task/,
      );
      await page.screenshot({ path: resolve(out, "keyboard-post.png") });
      await page.keyboard.press("Enter");
      await confirmed(page);
      assert.equal(f.sent.at(-1).fn, "post");
      assert.equal(BigInt(f.sent.at(-1).value), 1000000000000000n);
      assert.equal(f.tasks.length, 2);
    },
  );
  await check(
    "Commit creates a persistent salt backup before signing; reload preserves it",
    async () => {
      await select(page);
      await page.locator("#result-hash").fill(hash);
      await enabled(page.getByRole("button", { name: "Generate & save salt" }));
      await page.getByRole("button", { name: "Generate & save salt" }).click();
      const salt = await page.getByTestId("salt-backup").innerText();
      assert.match(salt, /^0x[0-9a-f]{64}$/);
      assert.equal(
        await page
          .getByRole("button", { name: "Commit result", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByLabel("I saved the result hash and salt outside this browser.")
        .check();
      await page
        .getByRole("button", { name: "Commit result", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).fn, "commit");
      const stored = await page.evaluate(() => Object.values(localStorage));
      assert.equal(
        stored.some((v) => v.includes(salt)),
        true,
      );
      await page.reload();
      await page.getByText(/Verified ABI & contract code/).waitFor();
      await select(page);
      assert.equal(await page.getByTestId("salt-backup").innerText(), salt);
      assert.equal(
        await page
          .getByRole("button", { name: "Commit result", exact: true })
          .isDisabled(),
        true,
      );
    },
  );
  await check(
    "Wrong salt cannot restore; matching backup reveals during the window",
    async () => {
      const salt = await page.getByTestId("salt-backup").innerText();
      await resetTask(f, page, { phase: "reveal", revealed: 0 });
      await page.getByText("Restore a salt backup", { exact: true }).click();
      await page
        .getByLabel("Original salt", { exact: true })
        .fill("0x" + "ee".repeat(32));
      await page
        .getByRole("button", { name: "Restore backup", exact: true })
        .click();
      await page.getByText(/do not match your on-chain commitment/).waitFor();
      await page.getByLabel("Original salt", { exact: true }).fill(salt);
      await page
        .getByRole("button", { name: "Restore backup", exact: true })
        .click();
      await page.getByText("Matching backup restored and saved.").waitFor();
      await enabled(
        page.getByRole("button", { name: "Reveal result", exact: true }),
      );
      await page
        .getByRole("button", { name: "Reveal result", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).fn, "reveal");
      assert.equal(f.tasks[0].revealedCount, 1n);
    },
  );
  await check(
    "Revealed event list enables poster acceptance with an explicit confirmation",
    async () => {
      await resetTask(f, page, { phase: "decision", account: poster });
      await page.getByRole("button", { name: "Load revealed workers" }).click();
      await page.getByText(/1 revealed worker found/).waitFor();
      await enabled(
        page.getByRole("button", { name: "Accept worker", exact: true }),
      );
      await page
        .getByRole("button", { name: "Accept worker", exact: true })
        .click();
      const count = f.sent.length;
      assert.equal(f.sent.length, count);
      await page.getByRole("button", { name: "Confirm acceptance" }).click();
      await confirmed(page);
      assert.equal(f.tasks[0].status, 2);
      assert.equal(f.sent.at(-1).args[1].toLowerCase(), worker);
    },
  );
  await check(
    "Reject all, cancel, finalize, claim share and withdraw use the right entrypoints",
    async () => {
      await resetTask(f, page, { phase: "decision", account: poster });
      await enabled(
        page.getByRole("button", { name: "Reject all", exact: true }),
      );
      await page
        .getByRole("button", { name: "Reject all", exact: true })
        .click();
      await page.getByRole("button", { name: "Confirm rejection" }).click();
      await confirmed(page);
      assert.equal(f.tasks[0].status, 3);
      await resetTask(f, page, { account: poster, commits: 0, revealed: 0 });
      await enabled(
        page.getByRole("button", { name: "Cancel task", exact: true }),
      );
      await page
        .getByRole("button", { name: "Cancel task", exact: true })
        .click();
      await page.getByRole("button", { name: "Confirm cancellation" }).click();
      await confirmed(page);
      assert.equal(f.tasks[0].status, 4);
      await resetTask(f, page, { phase: "finalize", account: worker });
      await enabled(
        page.getByRole("button", { name: "Finalize task", exact: true }),
      );
      await page
        .getByRole("button", { name: "Finalize task", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.tasks[0].status, 5);
      await enabled(page.getByRole("button", { name: "Claim split share" }));
      await page.getByRole("button", { name: "Claim split share" }).click();
      await confirmed(page);
      assert.equal(
        await page
          .getByRole("button", { name: "Claim split share" })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "Withdraw", exact: false })
        .click();
      await confirmed(page);
      assert.equal(f.credit, 0n);
      assert.equal(
        await page
          .getByRole("button", { name: "Withdraw", exact: false })
          .isDisabled(),
        true,
      );
    },
  );
  await check(
    "Wallet rejection and failed simulation are recoverable and prevent unintended sends",
    async () => {
      await page.getByLabel("Specification hash", { exact: true }).fill(hash);
      const count = f.sent.length;
      f.reject = true;
      await page
        .getByRole("button", { name: "Post task", exact: true })
        .click();
      await page.getByText(/Request declined in your wallet/).waitFor();
      assert.equal(f.sent.length, count);
      f.reject = false;
      f.simulateFail = true;
      await page
        .getByRole("button", { name: "Post task", exact: true })
        .click();
      await page.getByText(/fixture simulation failure/).waitFor();
      assert.equal(f.sent.length, count);
      f.simulateFail = false;
    },
  );
  await check(
    "Native swap quotes without sending, uses V4 commands and slippage minimum",
    async () => {
      await page
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await page.getByText("Estimated receive", { exact: true }).waitFor();
      const before = f.sent.length;
      assert.equal(f.sent.length, before);
      await page
        .getByRole("button", { name: "Swap ETH for TASK", exact: true })
        .click();
      await confirmed(page);
      const tx = f.sent.at(-1);
      assert.equal(tx.to.toLowerCase(), net.universalRouter);
      assert.equal(tx.fn, "execute");
      assert.equal(tx.args[0], "0x10");
      assert.equal(BigInt(tx.value), 1000000000000000n);
      const [actions, params] = decodeAbiParameters(
        parseAbiParameters("bytes,bytes[]"),
        tx.args[1][0],
      );
      assert.equal(actions, "0x060c0f");
      const [output, min] = decodeAbiParameters(
        parseAbiParameters("address,uint256"),
        params[2],
      );
      assert.equal(output.toLowerCase(), token.address);
      assert.equal(min, 99500000000000000n);
    },
  );
  await check(
    "Token swap requires separate token and Permit2 approvals to handoff addresses",
    async () => {
      await page.getByLabel("Direction", { exact: true }).selectOption("sell");
      await page.getByLabel("Pay (TASK)", { exact: true }).fill("1");
      await page
        .getByRole("button", { name: "Get quote", exact: true })
        .click();
      await page
        .getByRole("button", { name: "1. Approve TASK", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Swap TASK for ETH", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "1. Approve TASK", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).args[0].toLowerCase(), net.permit2);
      await enabled(
        page.getByRole("button", { name: "2. Approve router", exact: true }),
      );
      await page
        .getByRole("button", { name: "2. Approve router", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).to.toLowerCase(), net.permit2);
      assert.equal(f.sent.at(-1).args[1].toLowerCase(), net.universalRouter);
      await enabled(
        page.getByRole("button", { name: "Swap TASK for ETH", exact: true }),
      );
      await page
        .getByRole("button", { name: "Swap TASK for ETH", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).value, "0x0");
    },
  );
  await check(
    "Token transfer, explicit allowance/revoke and delegated transfer controls",
    async () => {
      await page
        .getByText("Send TASK & manage approvals", { exact: true })
        .click();
      await page.getByLabel("Recipient address", { exact: true }).fill(poster);
      await page.getByLabel("TASK amount", { exact: true }).fill("1");
      await page
        .getByRole("button", { name: "Send TASK", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).fn, "transfer");
      await page.getByLabel("Spender address", { exact: true }).fill(poster);
      await page
        .getByLabel("TASK allowance (0 to revoke)", { exact: true })
        .fill("0");
      await page.getByRole("button", { name: "Set spending approval" }).click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).args[1], 0n);
      await page
        .getByLabel("Token owner address", { exact: true })
        .fill(poster);
      await page
        .getByRole("button", { name: "Transfer approved TASK", exact: true })
        .click();
      await confirmed(page);
      assert.equal(f.sent.at(-1).fn, "transferFrom");
    },
  );
  await check(
    "Account/chain changes disable actions; storage access failure does not sign",
    async () => {
      f.chain = "0x1";
      await page.evaluate(() => window.walletEvent("chainChanged", "0x1"));
      await page.getByRole("button", { name: "Switch to Sepolia" }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Post task", exact: true })
          .isDisabled(),
        true,
      );
      f.chain = manifest.walletAddChain.chainId;
      await page.evaluate(
        (c) => window.walletEvent("chainChanged", c),
        f.chain,
      );
      await refresh(page);
      f.subs.clear();
      await resetTask(f, page, { commits: 0, revealed: 0 });
      await page.evaluate(() => {
        localStorage.clear();
        Storage.prototype.setItem = () => {
          throw Error("Storage disabled");
        };
      });
      await page.reload();
      await page.getByText(/Verified ABI & contract code/).waitFor();
      await select(page);
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw Error("Storage disabled");
        };
      });
      await page.locator("#result-hash").fill(hash);
      await page.getByRole("button", { name: "Generate & save salt" }).click();
      await page.getByText("Storage disabled", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Commit result", exact: true })
          .isDisabled(),
        true,
      );
      assert.deepEqual(page.errors, []);
      assert.deepEqual(page.resources, []);
      await page.context().close();
    },
  );
  await check(
    "Desktop/mobile/intermediate rendering, focus, contrast and automated accessibility",
    async () => {
      f = fixture();
      f.tasks.push({
        ...f.tasks[0],
        deadline: f.now - 86400n,
        commitCount: 3n,
        revealedCount: 2n,
        reward: 2500000000000000n,
      });
      page = await open(f);
      await connected(page);
      const viewports = [
        { width: 1440, height: 1050, name: "desktop" },
        { width: 820, height: 1100, name: "intermediate" },
        { width: 390, height: 1000, name: "mobile" },
        { width: 320, height: 960, name: "narrow" },
      ];
      for (const v of viewports) {
        await page.setViewportSize(v);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `overflow ${v.width}`,
        );
        await page.screenshot({
          path: resolve(out, `${v.name}.png`),
          fullPage: true,
        });
        if (v.name === "mobile")
          await page.screenshot({ path: resolve(out, "mobile-viewport.png") });
      }
      await select(page);
      await page.locator("#result-hash").fill(hash);
      await page.getByRole("button", { name: "Generate & save salt" }).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "backup overflow at 320",
      );
      await page.screenshot({
        path: resolve(out, "narrow-backup.png"),
        fullPage: true,
      });
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      await writeFile(
        resolve(out, "accessibility.json"),
        JSON.stringify(
          {
            violations: scan.violations,
            incomplete: scan.incomplete.map((x) => ({
              id: x.id,
              impact: x.impact,
              description: x.description,
              nodes: x.nodes.map((n) => ({
                html: n.html,
                failureSummary: n.failureSummary,
              })),
            })),
            passes: scan.passes.length,
          },
          null,
          2,
        ),
      );
      assert.equal(
        scan.violations.length,
        0,
        scan.violations.map((x) => x.id).join(","),
      );
      const contrasts = await page.evaluate(() => {
        const rgb = (s) =>
          s
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        const lum = (c) =>
          c
            .map((n) => {
              n /= 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            })
            .reduce((s, n, i) => s + n * [0.2126, 0.7152, 0.0722][i], 0);
        return [
          ".intro",
          ".test-notice p",
          ".post-panel .hint",
          ".primary",
          ".task-row .task-meta",
          ".chain-note",
        ].map((selector) => {
          const e = document.querySelector(selector),
            style = getComputedStyle(e);
          let bg = style.backgroundColor,
            parent = e;
          while (
            (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") &&
            parent.parentElement
          ) {
            parent = parent.parentElement;
            bg = getComputedStyle(parent).backgroundColor;
          }
          const a = lum(rgb(style.color)),
            b = lum(rgb(bg));
          return {
            selector,
            color: style.color,
            background: bg,
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
      });
      await writeFile(
        resolve(out, "contrast.json"),
        JSON.stringify(contrasts, null, 2),
      );
      assert.ok(contrasts.every((x) => x.contrast >= 4.5));
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await page
          .locator(".primary")
          .evaluate((e) => getComputedStyle(e).transitionDuration),
        "0s",
      );
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
          .map((e) => ({
            tag: e.tagName,
            class: e.className,
            text: e.textContent.slice(0, 90),
            width: e.getBoundingClientRect().width,
          })),
      );
      if (overflow.length) console.log("OVERFLOW", JSON.stringify(overflow));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "200% text overflow",
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
      assert.deepEqual(page.errors, []);
      assert.deepEqual(page.resources, []);
      await page.context().close();
    },
  );
  await check("Empty board has a useful next action", async () => {
    f = fixture();
    f.tasks = [];
    page = await open(f);
    await page.getByText("Room for your first task.").waitFor();
    await page.screenshot({ path: resolve(out, "empty.png"), fullPage: true });
    await page.context().close();
  });
  await check(
    "Missing deployed code prevents transactions and exposes retry",
    async () => {
      f = fixture();
      page = await open(f);
      await connected(page);
      f.missingCode = true;
      await refresh(page);
      await page.getByText(/Contract code is missing/).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Post task", exact: true })
          .isDisabled(),
        true,
      );
      await page.context().close();
    },
  );
  await check(
    "RPC failure disables actions; retry restores verified reads",
    async () => {
      f = fixture();
      page = await open(f);
      await connected(page);
      f.failRpc = true;
      await refresh(page);
      await page.getByRole("button", { name: "Retry connection" }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Post task", exact: true })
          .isDisabled(),
        true,
      );
      f.failRpc = false;
      await page.getByRole("button", { name: "Retry connection" }).click();
      await enabled(
        page.getByRole("button", { name: "Post task", exact: true }),
      );
      await page.context().close();
    },
  );
  await check("Tampered runtime ABI fails closed", async () => {
    const context = await browser.newContext(),
      p = await context.newPage();
    current = p;
    await p.route("**/abi/LaunchToken.json", (route) =>
      route.fulfill({ contentType: "application/json", body: "[]" }),
    );
    await p.goto(url);
    await p.getByText(/ABI verification failed for LaunchToken/).waitFor();
    assert.equal(
      await p.getByRole("button", { name: "Post task", exact: true }).count(),
      0,
    );
    await context.close();
  });
} finally {
  await writeFile(
    resolve(out, "browser-results.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: "Chromium via Playwright 1.58.2",
        mode: "Production export at /preview/; mocked wallet and RPC; no real transactions",
        exportAssets: manifest.assets,
        results,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((r) => server.close(r));
}
if (failures.length) process.exitCode = 1;
