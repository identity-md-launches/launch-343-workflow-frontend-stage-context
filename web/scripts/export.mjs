import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { keccak256, toHex } from "viem";
import { resolve, relative } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const handoff = JSON.parse(
  await readFile(resolve(root, "web/deployment/deployment.json")),
);
const networks = JSON.parse(
  await readFile(resolve(root, "web/deployment/network.json")),
);
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const abiHash = (abi) =>
  keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
if (
  networks.network.chainId !== handoff.chainId ||
  Number(BigInt(networks.walletAddChain.chainId)) !== handoff.chainId
)
  throw Error("Chain mismatch");
const out = resolve(root, "dist");
await mkdir(resolve(out, "abi"), { recursive: true });
const contracts = [];
for (const c of handoff.contracts) {
  const raw = execFileSync(
    "git",
    ["show", `${handoff.sourceCommit}:docs/abi/${c.name}.json`],
    { cwd: root },
  );
  const abi = JSON.parse(raw);
  if (!Array.isArray(abi) || abiHash(abi) !== c.abiHash)
    throw Error(`Pinned ABI mismatch: ${c.name}`);
  const abiPath = `abi/${c.name}.json`;
  await writeFile(resolve(out, abiPath), raw);
  contracts.push({
    name: c.name,
    address: c.address,
    abiHash: c.abiHash,
    abiPath,
  });
}
const assets = [];
async function walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) await walk(p);
    else if (ent.name !== "imd-deployment.json") {
      if ((await stat(p)).size > 8388608) throw Error("Asset too large");
      assets.push({
        path: relative(out, p).split("\\").join("/"),
        sha256: createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      });
    }
  }
}
await walk(out);
if (assets.length > 128) throw Error("Too many assets");
assets.sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts,
  assets,
  network: networks.network,
  walletAddChain: networks.walletAddChain,
  pool: handoff.manifest.pool,
  token: handoff.manifest.token,
  deploymentBlocks: Object.fromEntries(
    handoff.contracts.map((c) => [c.name, c.blockNumber]),
  ),
};
await writeFile(
  resolve(out, "imd-deployment.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Exported ${assets.length} assets; both pinned ABI hashes match the handoff.`,
);
