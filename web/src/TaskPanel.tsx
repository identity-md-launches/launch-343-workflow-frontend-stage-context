import { useEffect, useState } from "react";
import { formatEther, parseAbiItem, type Address, type Hex } from "viem";
import type { Runtime } from "./config";
import type { BoardState } from "./useBoard";
import {
  backupKey,
  commitment,
  eligibility,
  isHash,
  message,
  newBackup,
  persistBackup,
  phase,
  readBackup,
  type Backup,
  type Submission,
  type Task,
} from "./model";
export function DateText({ time }: { time: bigint }) {
  return (
    <time dateTime={new Date(Number(time) * 1000).toISOString()}>
      {new Date(Number(time) * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}
export function TaskPanel({
  task: t,
  runtime,
  state: s,
}: {
  task: Task;
  runtime: Runtime;
  state: BoardState;
}) {
  const board = runtime.contracts.SwarmJobBoard;
  const [submission, setSubmission] = useState<Submission>(),
    [backup, setBackup] = useState<Backup>(),
    [result, setResult] = useState(""),
    [salt, setSalt] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [ack, setAck] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [workers, setWorkers] = useState<
      { worker: Address; resultHash: Hex }[]
    >([]),
    [logStatus, setLogStatus] = useState(""),
    [logsBusy, setLogsBusy] = useState(false),
    [decision, setDecision] = useState<{
      fn: "accept" | "rejectAll" | "cancel";
      worker?: Address;
    }>();
  const key = s.account
    ? backupKey(runtime.config.chainId, board.address, s.account, t.id)
    : undefined;
  const gates = eligibility(t, submission, s.account, s.now),
    enabled = s.ready && loaded;
  useEffect(() => {
    setBackup(undefined);
    setResult("");
    setSalt("");
    setAck(false);
    setDecision(undefined);
    setError("");
    setWorkers([]);
    setLogStatus("");
    try {
      const b = key ? readBackup(key) : undefined;
      if (b) {
        setBackup(b);
        setResult(b.resultHash);
        setSalt(b.salt);
      }
    } catch (e) {
      setError(message(e));
    }
  }, [key]);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setSubmission(undefined);
    if (!s.account) return;
    s.reader
      .readContract({
        ...board,
        functionName: "submission",
        args: [t.id, s.account],
      })
      .then((v) => {
        if (alive) {
          setSubmission(v as Submission);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [s.account, s.reader, s.updated, t.id, board]);
  async function loadWorkers() {
    setLogsBusy(true);
    setLogStatus("Reading Revealed events…");
    setWorkers([]);
    try {
      const to = await s.reader.getBlockNumber(),
        start = BigInt(runtime.config.deploymentBlocks.SwarmJobBoard),
        found = new Map<string, { worker: Address; resultHash: Hex }>();
      for (let from = start; from <= to; from += 10000n) {
        const end = from + 9999n > to ? to : from + 9999n;
        const events = await s.reader.getLogs({
          address: board.address,
          event: parseAbiItem(
            "event Revealed(uint256 indexed taskId, address indexed worker, bytes32 resultHash)",
          ),
          args: { taskId: t.id },
          fromBlock: from,
          toBlock: end,
          strict: true,
        });
        for (const event of events)
          if (event.args.worker && event.args.resultHash)
            found.set(event.args.worker.toLowerCase(), {
              worker: event.args.worker,
              resultHash: event.args.resultHash,
            });
        setLogStatus(`Reading events through block ${end.toString()}…`);
      }
      setWorkers([...found.values()]);
      setLogStatus(
        `${found.size} revealed worker${found.size === 1 ? "" : "s"} found through block ${to}.`,
      );
    } catch (e) {
      setLogStatus(
        `Could not finish the event list: ${message(e)} Use “Load revealed workers” to retry.`,
      );
    } finally {
      setLogsBusy(false);
    }
  }
  function save() {
    setError("");
    setNotice("");
    try {
      if (!isHash(result))
        throw Error(
          "Enter a result hash: 0x followed by 64 hexadecimal characters.",
        );
      if (!s.account || !key) throw Error("Connect a wallet first.");
      if (
        submission?.commitment &&
        submission.commitment !== "0x" + "0".repeat(64)
      )
        throw Error(
          "This wallet already committed. Restore the original salt to reveal.",
        );
      if (backup)
        throw Error(
          "A backup already exists for this task. Keep it for your commitment.",
        );
      const b = newBackup(result, s.account, t.id);
      persistBackup(key, b);
      setBackup(b);
      setSalt(b.salt);
      setAck(false);
      setNotice(
        "Salt saved in this browser. Copy the backup before committing.",
      );
    } catch (e) {
      setError(message(e));
    }
  }
  function restore() {
    setError("");
    try {
      if (!key || !s.account || !isHash(result) || !isHash(salt))
        throw Error(
          "Enter your original 32-byte result hash and salt to restore.",
        );
      const b = {
        resultHash: result,
        salt,
        commitment: commitment(result, salt, s.account, t.id),
      };
      if (
        submission?.commitment &&
        submission.commitment !== "0x" + "0".repeat(64) &&
        submission.commitment !== b.commitment
      )
        throw Error(
          "This result and salt do not match your on-chain commitment. Check the backup and wallet.",
        );
      persistBackup(key, b);
      setBackup(b);
      setAck(false);
      setNotice("Matching backup restored and saved.");
    } catch (e) {
      setError(message(e));
    }
  }
  async function commit() {
    setError("");
    try {
      if (!backup || !key || !ack) throw Error("Save your backup first.");
      persistBackup(key, backup);
      await s.transact("Commit result", board, "commit", [
        t.id,
        backup.commitment,
      ]);
    } catch (e) {
      setError(message(e));
    }
  }
  async function reveal() {
    setError("");
    try {
      if (
        !backup ||
        !s.account ||
        commitment(backup.resultHash, backup.salt, s.account, t.id) !==
          submission?.commitment
      )
        throw Error(
          "Restore the result hash and salt that match your commitment.",
        );
      await s.transact("Reveal result", board, "reveal", [
        t.id,
        backup.resultHash,
        backup.salt,
      ]);
    } catch (e) {
      setError(message(e));
    }
  }
  async function settle() {
    if (!decision) return;
    setError("");
    try {
      if (decision.worker) {
        const sub = (await s.reader.readContract({
          ...board,
          functionName: "submission",
          args: [t.id, decision.worker],
        })) as Submission;
        if (!sub.revealed)
          throw Error("This worker has not revealed. Refresh the event list.");
      }
      const ok = await s.transact(
        decision.fn === "accept"
          ? "Accept worker"
          : decision.fn === "rejectAll"
            ? "Reject all results"
            : "Cancel task",
        board,
        decision.fn,
        decision.worker ? [t.id, decision.worker] : [t.id],
      );
      if (ok) setDecision(undefined);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <section className="task-detail" aria-label={`Task ${t.id} details`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">Selected task</span>
          <h2>Task #{t.id.toString()}</h2>
        </div>
        <span className="badge">{phase(t, s.now)}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Reward</dt>
          <dd>{formatEther(t.reward)} ETH</dd>
        </div>
        <div>
          <dt>Committed / revealed</dt>
          <dd>
            {t.commitCount.toString()} / {t.revealedCount.toString()}
          </dd>
        </div>
        <div>
          <dt>Poster</dt>
          <dd>
            <a
              className="mono"
              href={`${runtime.config.network.explorer}/address/${t.poster}`}
              target="_blank"
              rel="noreferrer"
            >
              {t.poster}
            </a>
          </dd>
        </div>
        <div>
          <dt>Specification hash</dt>
          <dd className="mono">{t.specHash}</dd>
        </div>
      </dl>
      <ol className="timeline">
        <li>
          <b>01 · Commit closes</b>
          <DateText time={t.deadline} />
        </li>
        <li>
          <b>02 · Reveal closes</b>
          <DateText time={t.deadline + 86400n} />
        </li>
        <li>
          <b>03 · Decision closes</b>
          <DateText time={t.deadline + 604800n} />
        </li>
      </ol>
      <p className="hint">
        Dates use your local time. Eligibility uses the latest chain timestamp.
        Work and specifications are shared off-chain.
      </p>
      <h3>Commit & reveal</h3>
      <p className="hint">
        One commitment per wallet. The poster cannot commit. Keep the result
        hash and salt until your reveal is confirmed.
      </p>
      <div className="fields">
        <label>
          Result hash
          <input
            id="result-hash"
            value={result}
            onChange={(e) => setResult(e.target.value)}
            readOnly={!!backup}
            placeholder="0x… (32 bytes)"
            spellCheck={false}
            aria-invalid={!!error && !isHash(result)}
            aria-describedby="task-error"
          />
        </label>
        <button onClick={save} disabled={!enabled || !gates.commit || !!backup}>
          Generate & save salt
        </button>
      </div>
      {backup && (
        <div className="backup">
          <b>Private salt backup</b>
          <p className="hint">
            Saved only in this browser. Clearing browser data loses it. Store
            both values somewhere private.
          </p>
          <dl>
            <dt>Result hash</dt>
            <dd className="mono">{backup.resultHash}</dd>
            <dt>Salt</dt>
            <dd className="mono" data-testid="salt-backup">
              {backup.salt}
            </dd>
          </dl>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  JSON.stringify(
                    {
                      chainId: runtime.config.chainId,
                      contract: board.address,
                      account: s.account,
                      taskId: t.id.toString(),
                      ...backup,
                    },
                    null,
                    2,
                  ),
                );
                setNotice("Backup copied. Store it somewhere private.");
              } catch {
                setError(
                  "Clipboard unavailable. Select and copy the visible result hash and salt.",
                );
              }
            }}
          >
            Copy backup
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I saved the result hash and salt outside this browser.
          </label>
        </div>
      )}
      <details>
        <summary>Restore a salt backup</summary>
        <p className="hint">
          Use the wallet that originally committed. Restoring validates the
          commitment when one exists.
        </p>
        <label>
          Original result hash
          <input
            value={result}
            onChange={(e) => {
              setBackup(undefined);
              setResult(e.target.value);
            }}
            spellCheck={false}
          />
        </label>
        <label>
          Original salt
          <input
            value={salt}
            onChange={(e) => setSalt(e.target.value)}
            spellCheck={false}
          />
        </label>
        <button onClick={restore} disabled={!enabled}>
          Restore backup
        </button>
      </details>
      <div className="actions">
        <button
          disabled={!enabled || !gates.commit || !backup || !ack}
          onClick={() => void commit()}
        >
          Commit result
        </button>
        <button
          disabled={!enabled || !gates.reveal || !backup}
          onClick={() => void reveal()}
        >
          Reveal result
        </button>
      </div>
      <p className="hint">
        {!s.account
          ? "Connect a wallet to check your eligibility."
          : !loaded
            ? "Loading your submission…"
            : submission?.revealed
              ? "Your result is revealed."
              : gates.reveal
                ? "Reveal now, before the reveal window closes."
                : gates.commit
                  ? "Commit before the deadline, then return during the 24-hour reveal window."
                  : "Commit and reveal controls are unavailable for this wallet or phase."}
      </p>
      <p className="error" id="task-error" role="alert">
        {error}
      </p>
      <p role="status">{notice}</p>
      <div className="section-heading">
        <h3>Revealed workers</h3>
        <button
          disabled={logsBusy || !s.verified}
          onClick={() => void loadWorkers()}
        >
          {logsBusy ? "Loading events…" : "Load revealed workers"}
        </button>
      </div>
      <p className="hint" role="status">
        {logStatus ||
          "Read worker addresses and result hashes directly from contract events."}
      </p>
      {workers.map((w) => (
        <div className="worker" key={w.worker}>
          <a
            className="mono"
            href={`${runtime.config.network.explorer}/address/${w.worker}`}
            target="_blank"
            rel="noreferrer"
          >
            {w.worker}
          </a>
          <span className="mono">{w.resultHash}</span>
          <button
            disabled={!enabled || !gates.accept}
            onClick={() => setDecision({ fn: "accept", worker: w.worker })}
          >
            Accept worker
          </button>
        </div>
      ))}
      <h3>Settle task</h3>
      <p className="hint">
        The poster may accept a revealed worker or reject all during the
        decision window. Cancel is available only before anyone commits. After
        seven days, anyone can finalize.
      </p>
      <div className="actions">
        <button
          disabled={!enabled || !gates.rejectAll}
          onClick={() => setDecision({ fn: "rejectAll" })}
        >
          Reject all
        </button>
        <button
          disabled={!enabled || !gates.cancel}
          onClick={() => setDecision({ fn: "cancel" })}
        >
          Cancel task
        </button>
        <button
          disabled={!enabled || !gates.finalize}
          onClick={() =>
            void s.transact("Finalize task", board, "finalize", [t.id])
          }
        >
          Finalize task
        </button>
        <button
          disabled={!enabled || !gates.claimSplit}
          onClick={() =>
            void s.transact("Claim split share", board, "claimSplit", [t.id])
          }
        >
          Claim split share
        </button>
      </div>
      {t.status === 5 && (
        <p>
          Split share: {formatEther(t.share)} ETH per revealed worker. Claim
          once, then withdraw.
        </p>
      )}
      {decision && (
        <div
          className="confirmation"
          role="group"
          aria-label="Confirm settlement"
        >
          <b>
            {decision.fn === "accept"
              ? "Credit the entire reward to this worker?"
              : "Refund the entire reward to the poster?"}
          </b>
          <p>
            {decision.worker || `Task #${t.id}`} · {formatEther(t.reward)} ETH.
            This ends the task permanently. Funds will be available to withdraw.
          </p>
          <div className="actions">
            <button
              disabled={!enabled || !gates[decision.fn]}
              onClick={() => void settle()}
            >
              Confirm{" "}
              {decision.fn === "accept"
                ? "acceptance"
                : decision.fn === "cancel"
                  ? "cancellation"
                  : "rejection"}
            </button>
            <button onClick={() => setDecision(undefined)}>
              Keep task open
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
