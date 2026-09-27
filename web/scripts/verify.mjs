import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
const root = resolve(import.meta.dirname, "../.."),
  out = resolve(root, "dist");
const manifest = JSON.parse(
  await readFile(resolve(out, "imd-deployment.json")),
);
const handoff = JSON.parse(
  await readFile(resolve(root, "web/deployment/deployment.json")),
);
const network = JSON.parse(
  await readFile(resolve(root, "web/deployment/network.json")),
);
function canonical(v) {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
for (const k of [
  "version",
  "launchId",
  "chainId",
  "sourceCommit",
  "attestationHash",
])
  assert.equal(manifest[k], handoff[k]);
assert.deepEqual(manifest.network, network.network);
assert.deepEqual(manifest.walletAddChain, network.walletAddChain);
assert.deepEqual(
  manifest.contracts.map(({ abiPath, ...c }) => c),
  handoff.contracts.map(({ name, address, abiHash }) => ({
    name,
    address,
    abiHash,
  })),
);
for (const c of manifest.contracts) {
  const raw = await readFile(resolve(out, c.abiPath));
  assert.deepEqual(
    raw,
    execFileSync(
      "git",
      ["show", `${handoff.sourceCommit}:docs/abi/${c.name}.json`],
      { cwd: root },
    ),
  );
  assert.equal(
    keccak256(toHex(JSON.stringify(canonical(JSON.parse(raw))))).slice(2),
    c.abiHash,
  );
}
const files = await readdir(out, { recursive: true });
let bytes = 0;
const actual = [];
for (const f of files) {
  const s = await stat(resolve(out, f));
  if (s.isFile()) {
    bytes += s.size;
    if (f !== "imd-deployment.json") actual.push(f);
  }
}
assert.deepEqual(actual.sort(), manifest.assets.map((a) => a.path).sort());
assert.ok(actual.length <= 128);
assert.ok(bytes < 8 * 1024 * 1024);
for (const a of manifest.assets) {
  assert.match(a.path, /^[\w./-]+$/);
  assert.ok(!a.path.startsWith("/") && !a.path.split("/").includes(".."));
  const raw = await readFile(resolve(out, a.path));
  assert.ok(raw.length <= 8388608);
  assert.equal(createHash("sha256").update(raw).digest("hex"), a.sha256);
}
console.log(
  JSON.stringify(
    {
      result: "PASS",
      assets: actual.length,
      exportBytes: bytes,
      pinnedAbis: manifest.contracts.length,
      network: "exact match",
    },
    null,
    2,
  ),
);
