import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
} from "viem";
import { readFileSync } from "node:fs";
import {
  parseAmount,
  backupKey,
  commitment,
  eligibility,
  newBackup,
  persistBackup,
  phase,
  readBackup,
  zeroHash,
  type Task,
  type Submission,
} from "../src/model";
import {
  hashAbi,
  switchNetwork,
  type Runtime,
  type Provider,
} from "../src/config";
import { minimumOutput, swapInput, keyType } from "../src/swap";
const worker = "0x1111111111111111111111111111111111111111",
  poster = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}` as const,
  salt = `0x${"cd".repeat(32)}` as const;
const task: Task = {
  id: 1n,
  poster,
  deadline: 100000n,
  status: 1,
  specHash: hash,
  reward: 1001n,
  commitCount: 1n,
  revealedCount: 1n,
  share: 0n,
};
const sub: Submission = {
  commitment: hash,
  resultHash: zeroHash,
  revealed: false,
  splitClaimed: false,
};
test("phase gates enforce all exact boundaries", () => {
  assert.equal(phase(task, 99999n), "Commit");
  assert.equal(phase(task, 100000n), "Reveal");
  assert.equal(phase(task, 186400n), "Decision");
  assert.equal(phase(task, 704800n), "Awaiting finalization");
  assert.equal(eligibility(task, undefined, worker, 99999n).commit, true);
  assert.equal(eligibility(task, undefined, worker, 100000n).commit, false);
  assert.equal(eligibility(task, sub, worker, 100000n).reveal, true);
  assert.equal(eligibility(task, sub, worker, 186400n).reveal, false);
  assert.equal(eligibility(task, sub, poster, 186399n).accept, false);
  assert.equal(eligibility(task, sub, poster, 186400n).accept, true);
  assert.equal(eligibility(task, sub, poster, 704800n).rejectAll, false);
  assert.equal(eligibility(task, sub, worker, 704799n).finalize, false);
  assert.equal(eligibility(task, sub, worker, 704800n).finalize, true);
});
test("poster, existing commitments and settled tasks cannot commit", () => {
  assert.equal(eligibility(task, undefined, poster, 99999n).commit, false);
  assert.equal(eligibility(task, sub, worker, 99999n).commit, false);
  for (const status of [2, 3, 4, 5])
    assert.equal(
      eligibility({ ...task, status }, undefined, worker, 99999n).commit,
      false,
    );
});
test("cancel requires poster and zero commits, with no invented deadline gate", () => {
  assert.equal(
    eligibility({ ...task, commitCount: 0n }, undefined, poster, 900000n)
      .cancel,
    true,
  );
  assert.equal(eligibility(task, undefined, poster, 99999n).cancel, false);
  assert.equal(
    eligibility({ ...task, commitCount: 0n }, undefined, worker, 99999n).cancel,
    false,
  );
});
test("claim requires finalization and revealed, unclaimed submission", () => {
  assert.equal(
    eligibility(
      { ...task, status: 5 },
      { ...sub, revealed: true },
      worker,
      900000n,
    ).claimSplit,
    true,
  );
  assert.equal(
    eligibility(
      { ...task, status: 5 },
      { ...sub, revealed: true, splitClaimed: true },
      worker,
      900000n,
    ).claimSplit,
    false,
  );
  assert.equal(
    eligibility({ ...task, status: 5 }, sub, worker, 900000n).claimSplit,
    false,
  );
});
test("commitment is abi.encode, bound to sender/task/result/salt", () => {
  const c = commitment(hash, salt, worker, 1n);
  assert.equal(
    c,
    keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32,bytes32,address,uint256"),
        [hash, salt, worker, 1n],
      ),
    ),
  );
  assert.notEqual(c, commitment(hash, salt, poster, 1n));
  assert.notEqual(c, commitment(hash, salt, worker, 2n));
  assert.notEqual(c, commitment(hash, hash, worker, 1n));
});
test("salt uses random bytes and persists without changing on reload", () => {
  const map = new Map(),
    storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
    } as Storage;
  const key = backupKey(1, poster, worker, 1n),
    b = newBackup(hash, worker, 1n);
  assert.match(b.salt, /^0x[0-9a-f]{64}$/);
  assert.notEqual(b.salt, newBackup(hash, worker, 1n).salt);
  persistBackup(key, b, storage);
  assert.deepEqual(readBackup(key, storage), b);
  assert.notEqual(key, backupKey(1, poster, worker, 2n));
  assert.notEqual(key, backupKey(1, poster, poster, 1n));
});
test("storage failures prevent saving a salt", () => {
  const b = newBackup(hash, worker, 1n);
  assert.throws(() =>
    persistBackup("key", b, {
      setItem() {
        throw Error("denied");
      },
    } as unknown as Storage),
  );
  assert.throws(() =>
    persistBackup("key", b, {
      setItem() {},
      getItem() {
        return null;
      },
    } as unknown as Storage),
  );
});
test("unknown chain adds exact supplied network then switches again", async () => {
  const params = { chainId: "0xaa36a7", chainName: "Fixture" },
    calls: any[] = [];
  let unknown = true;
  const p = {
    request: async (x: any) => {
      calls.push(x);
      if (x.method === "wallet_switchEthereumChain" && unknown) {
        unknown = false;
        throw { code: 4902 };
      }
    },
  } as unknown as Provider;
  await switchNetwork(p, { walletAddChain: params } as any);
  assert.deepEqual(
    calls.map((x) => x.method),
    [
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ],
  );
  assert.deepEqual(calls[1].params, [params]);
});
test("user rejection does not try adding a chain", async () => {
  let calls = 0;
  await assert.rejects(
    switchNetwork(
      {
        request: async () => {
          calls++;
          throw { code: 4001 };
        },
      } as unknown as Provider,
      { walletAddChain: { chainId: "0x1" } } as any,
    ),
  );
  assert.equal(calls, 1);
});
test("pinned ABI hashes match runtime hashing", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../dist/imd-deployment.json", import.meta.url),
      "utf8",
    ),
  );
  for (const c of manifest.contracts)
    assert.equal(
      hashAbi(
        JSON.parse(
          readFileSync(
            new URL(`../../dist/${c.abiPath}`, import.meta.url),
            "utf8",
          ),
        ),
      ),
      c.abiHash,
    );
});
test("slippage rejects unsafe input and rounds minimum down", () => {
  assert.equal(minimumOutput(123456n, "0.5"), 122838n);
  for (const v of ["0", "-1", "5.1", "abc", ""])
    assert.throws(() => minimumOutput(10n, v));
});
test("V4 swap encoding uses exact action sequence, sorted pool and minimum in TAKE_ALL", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../dist/imd-deployment.json", import.meta.url),
      "utf8",
    ),
  );
  const runtime = {
    config,
    contracts: Object.fromEntries(
      config.contracts.map((c: any) => [c.name, c]),
    ),
  } as Runtime;
  for (const buy of [true, false]) {
    const data = swapInput(runtime, buy, 100n, 90n);
    const [actions, params] = decodeAbiParameters(
      parseAbiParameters("bytes,bytes[]"),
      data,
    );
    assert.equal(actions, "0x060c0f");
    const [swap] = decodeAbiParameters(
      parseAbiParameters(
        `(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`,
      ),
      params[0],
    );
    assert.equal(swap.amountIn, 100n);
    assert.equal(swap.amountOutMinimum, 90n);
    assert.equal(swap.zeroForOne, buy);
    assert.equal(swap.poolKey.fee, config.pool.fee);
    assert.equal(swap.poolKey.hooks, "0x" + "0".repeat(40));
    const [input, inputAmount] = decodeAbiParameters(
      parseAbiParameters("address,uint256"),
      params[1],
    );
    const [output, min] = decodeAbiParameters(
      parseAbiParameters("address,uint256"),
      params[2],
    );
    assert.equal(inputAmount, 100n);
    assert.equal(min, 90n);
    assert.notEqual(input, output);
  }
});

test("amount parsing never silently rounds a visitor input", () => {
  assert.equal(parseAmount(".001", 18), 1000000000000000n);
  assert.equal(parseAmount("0", 18), 0n);
  for (const value of ["0.0000000000000000001", "-1", "1e3", "NaN", ""])
    assert.throws(() => parseAmount(value, 18));
});
