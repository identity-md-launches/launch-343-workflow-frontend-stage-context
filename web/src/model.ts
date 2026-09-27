import {
  encodeAbiParameters,
  parseUnits,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
export type Task = {
  id: bigint;
  poster: Address;
  deadline: bigint;
  status: number;
  specHash: Hex;
  reward: bigint;
  commitCount: bigint;
  revealedCount: bigint;
  share: bigint;
};
export type Submission = {
  commitment: Hex;
  resultHash: Hex;
  revealed: boolean;
  splitClaimed: boolean;
};
export const zeroHash = `0x${"0".repeat(64)}` as Hex;
export function phase(t: Task, now: bigint) {
  return t.status !== 1
    ? ["Unknown", "Open", "Accepted", "Rejected", "Cancelled", "Finalized"][
        t.status
      ] || "Unknown"
    : now < t.deadline
      ? "Commit"
      : now < t.deadline + 86400n
        ? "Reveal"
        : now < t.deadline + 604800n
          ? "Decision"
          : "Awaiting finalization";
}
export function eligibility(
  t: Task,
  s: Submission | undefined,
  account: Address | undefined,
  now: bigint,
) {
  const poster = account?.toLowerCase() === t.poster.toLowerCase(),
    open = t.status === 1,
    p = phase(t, now),
    committed = !!s && s.commitment !== zeroHash;
  return {
    commit: !!account && open && !poster && p === "Commit" && !committed,
    reveal: !!account && open && p === "Reveal" && committed && !s?.revealed,
    accept: !!account && open && poster && p === "Decision",
    rejectAll: !!account && open && poster && p === "Decision",
    cancel: !!account && open && poster && t.commitCount === 0n,
    finalize: !!account && open && p === "Awaiting finalization",
    claimSplit: !!account && t.status === 5 && !!s?.revealed && !s.splitClaimed,
  };
}
export function commitment(
  result: Hex,
  salt: Hex,
  account: Address,
  id: bigint,
) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, address, uint256"),
      [result, salt, account, id],
    ),
  );
}
export type Backup = { resultHash: Hex; salt: Hex; commitment: Hex };
export function backupKey(
  chain: number,
  contract: Address,
  account: Address,
  id: bigint,
) {
  return `taskboard:${chain}:${contract.toLowerCase()}:${account.toLowerCase()}:${id}`;
}
export function newBackup(
  resultHash: Hex,
  account: Address,
  id: bigint,
): Backup {
  const salt =
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
  return {
    resultHash,
    salt,
    commitment: commitment(resultHash, salt, account, id),
  };
}
export function persistBackup(
  key: string,
  b: Backup,
  storage: Storage = localStorage,
) {
  storage.setItem(key, JSON.stringify(b));
  if (storage.getItem(key) !== JSON.stringify(b))
    throw Error(
      "Salt backup could not be saved. Enable local storage and try again.",
    );
}
export function readBackup(
  key: string,
  storage: Storage = localStorage,
): Backup | undefined {
  const value = storage.getItem(key);
  if (!value) return;
  const b = JSON.parse(value);
  if (!isHash(b.resultHash) || !isHash(b.salt) || !isHash(b.commitment))
    throw Error("Saved backup is damaged. Restore your result hash and salt.");
  return b;
}
export function isHash(v: string): v is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}
export function message(e: unknown) {
  const x = e as { shortMessage?: string; message?: string; code?: number };
  return x.code === 4001 ||
    /user rejected|user denied/i.test(x.shortMessage || x.message || "")
    ? "Request declined in your wallet. You can try again."
    : x.shortMessage ||
        x.message ||
        "Request failed. Check your connection and retry.";
}

export function parseAmount(value: string, decimals: number): bigint {
  if (
    !/^(?:\d+|\d*\.\d+)$/.test(value) ||
    (value.split(".")[1] || "").length > decimals
  )
    throw Error(
      `Use a nonnegative decimal amount with at most ${decimals} decimal places.`,
    );
  return parseUnits(value, decimals);
}
