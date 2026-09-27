import { readFile, writeFile } from "node:fs/promises";
const config = JSON.parse(
  await readFile(new URL("../../dist/imd-deployment.json", import.meta.url)),
);
const results = [];
for (const url of config.network.rpcUrls) {
  const entry = { url };
  results.push(entry);
  try {
    async function rpc(method, params = []) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12000),
      });
      entry.httpStatus = res.status;
      if (!res.ok) throw Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw Error(json.error.message);
      return json.result;
    }
    entry.chainId = Number(BigInt(await rpc("eth_chainId")));
    if (entry.chainId !== config.chainId) throw Error("Chain mismatch");
    entry.contracts = [];
    for (const c of config.contracts) {
      const code = await rpc("eth_getCode", [c.address, "latest"]);
      entry.contracts.push({
        name: c.name,
        address: c.address,
        codeBytes: (code.length - 2) / 2,
      });
      if (code === "0x") throw Error("Missing code");
    }
    entry.result = "PASS";
  } catch (e) {
    entry.result = "UNAVAILABLE";
    entry.error = e.message;
  }
}
await writeFile(
  new URL("../../docs/evidence/live-rpc.json", import.meta.url),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      mode: "Read-only worker checks; no signing or transactions",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(results, null, 2));
if (!results.some((r) => r.result === "PASS")) process.exitCode = 1;
