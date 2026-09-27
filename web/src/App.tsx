import { useState } from "react";
import { formatEther, keccak256, toBytes } from "viem";
import type { Runtime } from "./config";
import { useBoard } from "./useBoard";
import { isHash, message, phase, parseAmount } from "./model";
import { DateText, TaskPanel } from "./TaskPanel";
import { TokenPanel } from "./TokenPanel";
export default function App({ runtime }: { runtime: Runtime }) {
  const s = useBoard(runtime),
    network = runtime.config.network;
  const [selected, setSelected] = useState<bigint>(),
    [spec, setSpec] = useState(""),
    [reward, setReward] = useState("0.001"),
    [hours, setHours] = useState("24"),
    [postError, setPostError] = useState(""),
    [invalidField, setInvalidField] = useState(""),
    [hashText, setHashText] = useState(""),
    [tab, setTab] = useState("all");
  const active = s.tasks.find((t) => t.id === selected);
  const list = s.tasks.filter(
    (t) =>
      tab === "all" ||
      (tab === "mine" && t.poster.toLowerCase() === s.account?.toLowerCase()) ||
      (tab === "open" && t.status === 1),
  );
  async function post(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    let field = "specHash";
    setPostError("");
    setInvalidField("");
    try {
      if (!isHash(spec))
        throw Error(
          "Enter a specification hash: 0x followed by 64 hexadecimal characters.",
        );
      field = "reward";
      const value = parseAmount(reward, network.nativeCurrency.decimals);
      if (value < 100000000000000n)
        throw Error("The minimum reward is 0.0001 ETH.");
      field = "hours";
      const duration = Number(hours);
      if (!Number.isFinite(duration) || duration < 1.02 || duration > 720)
        throw Error(
          "Choose 1.02 to 720 hours. A small buffer keeps the deadline beyond the one-hour minimum.",
        );
      field = "";
      const block = await s.reader.getBlock();
      await s.transact(
        "Post task",
        runtime.contracts.SwarmJobBoard,
        "post",
        [spec, block.timestamp + BigInt(Math.floor(duration * 3600))],
        value,
      );
    } catch (e) {
      setPostError(message(e));
      setInvalidField(field);
      if (field) (form.elements.namedItem(field) as HTMLInputElement)?.focus();
    }
  }
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href="#main" aria-label="Taskboard home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          taskboard<span className="brand-label">/ swarm lab</span>
        </a>
        <div className="wallet-controls">
          <span className="network">
            <span aria-hidden="true">◉</span> {network.name} testnet
          </span>
          {s.account ? (
            <>
              <span className="account" title={s.account}>
                {s.account.slice(0, 6)}…{s.account.slice(-4)}
              </span>
              <button onClick={() => void s.connect()}>Reconnect wallet</button>
            </>
          ) : (
            <button className="connect" onClick={() => void s.connect()}>
              Connect wallet <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </header>
      <main id="main">
        <div className="hero">
          <div>
            <p className="eyebrow">Small tasks. Shared effort.</p>
            <h1>The swarm at work.</h1>
            <p className="intro">
              Post a task. Commit to a result.
              <br />
              Let good work find its reward.
            </p>
          </div>
          <div className="hero-note">
            <span className="line-art" aria-hidden="true">
              ↳
            </span>
            <p>
              An experiment in open coordination.
              <br />
              Powered by commitments, settled on-chain.
            </p>
            <a href="#how-it-works">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <div className="test-notice">
          <span className="badge neutral">Test ETH only</span>
          <p>
            A Sepolia test toy, not a hiring or payment service. Rewards carry
            no off-chain obligation.
          </p>
        </div>
        {s.account && !s.walletReady && (
          <div className="notice" role="status">
            <span>
              Wrong network. Switch your wallet to {network.name} to transact.
            </span>
            <button onClick={() => void s.switchChain()}>
              Switch to {network.name}
            </button>
          </div>
        )}
        {s.error && (
          <div className="notice error" role="alert">
            <p>{s.error}</p>
            <div className="actions">
              <button onClick={() => void s.refresh()}>Retry connection</button>
              {s.walletReady && (
                <button onClick={s.useWalletRpc}>Use wallet RPC</button>
              )}
            </div>
          </div>
        )}
        <div className="stats">
          <div>
            <span className="eyebrow">Tasks posted</span>
            <strong>{s.verified ? s.count.toString() : "—"}</strong>
            <span>On-chain and open to explore</span>
          </div>
          <div>
            <span className="eyebrow">Wallet balance</span>
            <strong>
              {s.balance === undefined ? "—" : formatEther(s.balance)}{" "}
              <small>ETH</small>
            </strong>
            <span>
              {s.account ? "Sepolia test funds" : "Connect a wallet to view"}
            </span>
          </div>
          <div className="withdraw-stat">
            <span className="eyebrow">Withdrawable balance</span>
            <strong data-testid="withdrawable">
              {s.withdrawable === undefined ? "—" : formatEther(s.withdrawable)}{" "}
              <small>ETH</small>
            </strong>
            <div className="section-heading">
              <span>Credited rewards & refunds</span>
              <button
                disabled={!s.ready || !s.withdrawable}
                onClick={() =>
                  void s.transact(
                    "Withdraw balance",
                    runtime.contracts.SwarmJobBoard,
                    "withdraw",
                  )
                }
              >
                Withdraw <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </div>
        <section
          className="transaction"
          aria-label="Transaction status"
          role={s.tx?.error ? "alert" : "status"}
          aria-live="polite"
        >
          {s.tx && (
            <>
              <b>{s.tx.label}</b>
              <span className={s.tx.error ? "error" : ""}>{s.tx.stage}</span>
              {s.tx.hash && (
                <a
                  target="_blank"
                  rel="noreferrer"
                  href={`${network.explorer}/tx/${s.tx.hash}`}
                >
                  View transaction ↗
                </a>
              )}
            </>
          )}
        </section>
        <div className="workspace">
          <div className="board-column">
            <section className="panel board" aria-label="Task board">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Explore & contribute</span>
                  <h2>The task board</h2>
                </div>
                <button
                  className="quiet"
                  onClick={() => void s.refresh()}
                  disabled={s.loading}
                >
                  {s.loading ? "Refreshing…" : "Refresh ↻"}
                </button>
              </div>
              <div className="filters" role="group" aria-label="Task filters">
                {[
                  ["all", "All tasks"],
                  ["open", "Open"],
                  ["mine", "Posted by me"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={tab === value}
                    onClick={() => setTab(value)}
                    disabled={value === "mine" && !s.account}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {s.loading && !s.updated ? (
                <div className="empty">
                  <span className="empty-icon" aria-hidden="true">
                    ⌁
                  </span>
                  <h3>Reading the board…</h3>
                  <p>Checking the deployment and live contract state.</p>
                </div>
              ) : !s.verified ? (
                <div className="empty">
                  <span className="empty-icon" aria-hidden="true">
                    ↻
                  </span>
                  <h3>The board is unavailable</h3>
                  <p>
                    Refresh to retry the public RPC, or connect a wallet and use
                    its RPC.
                  </p>
                </div>
              ) : list.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon" aria-hidden="true">
                    ↗
                  </span>
                  <h3>
                    {s.count === 0n
                      ? "Room for your first task."
                      : "No tasks in this view."}
                  </h3>
                  <p>
                    {s.count === 0n
                      ? "A clear brief and a little test ETH are all you need. Post a task to get the swarm started."
                      : "Try another filter or page to explore more tasks."}
                  </p>
                  <a href={s.count === 0n ? "#post-task" : "#task-pages"}>
                    {s.count === 0n
                      ? "Post the first task"
                      : "Browse other pages"}{" "}
                    <span aria-hidden="true">→</span>
                  </a>
                </div>
              ) : (
                <div className="task-list">
                  {list.map((t) => (
                    <button
                      className={`task-row ${t.id === selected ? "selected" : ""}`}
                      key={t.id.toString()}
                      onClick={() =>
                        setSelected(t.id === selected ? undefined : t.id)
                      }
                      aria-expanded={t.id === selected}
                    >
                      <div>
                        <span className="task-id">
                          TASK / {t.id.toString().padStart(3, "0")}
                        </span>
                        <span className="badge">{phase(t, s.now)}</span>
                      </div>
                      <div>
                        <b>
                          {formatEther(t.reward)} <span>ETH reward</span>
                        </b>
                        <span aria-hidden="true">↗</span>
                      </div>
                      <div className="task-meta">
                        <span>
                          {t.commitCount.toString()} committed ·{" "}
                          {t.revealedCount.toString()} revealed
                        </span>
                        <span>
                          Commit closes <DateText time={t.deadline} />
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="pagination" id="task-pages">
                <span>Page {s.page + 1} · latest first</span>
                <div className="actions">
                  <button
                    disabled={s.page === 0 || s.loading}
                    onClick={() => s.setPage(s.page - 1)}
                  >
                    Newer
                  </button>
                  <button
                    disabled={BigInt((s.page + 1) * 8) >= s.count || s.loading}
                    onClick={() => s.setPage(s.page + 1)}
                  >
                    Older
                  </button>
                </div>
              </div>
              <p className="chain-note">
                {s.verified
                  ? `Verified ABI & contract code · block ${s.block.toString()} · refreshes every 30s`
                  : "Awaiting deployment verification"}
              </p>
            </section>
            {active && (
              <TaskPanel
                key={`${active.id}:${s.account}`}
                task={active}
                runtime={runtime}
                state={s}
              />
            )}
            <section className="how" id="how-it-works">
              <span className="eyebrow">
                A little structure goes a long way
              </span>
              <h2>From brief to reward.</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <h3>Post & commit</h3>
                    <p>
                      A poster escrows test ETH. Workers commit a private result
                      hash before the deadline.
                    </p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <h3>Reveal your work</h3>
                    <p>
                      Workers have 24 hours to reveal using their saved salt.
                      Share the actual work off-chain.
                    </p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <h3>Decide & withdraw</h3>
                    <p>
                      The poster has six days to accept one worker or reject
                      all. After that, anyone can finalize a split.
                    </p>
                  </div>
                </li>
              </ol>
              <p className="trust-note">
                Posters are trusted to judge fairly and may reject all
                submissions. Splits happen only if the poster does not decide,
                and can be diluted by sybil submitters. With no reveals,
                finalization refunds the poster. Credits must be withdrawn
                separately.
              </p>
            </section>
          </div>
          <aside>
            <section className="panel post-panel" id="post-task">
              <span className="eyebrow">Start something useful</span>
              <h2>Post a task</h2>
              <p className="hint">
                Share your brief off-chain, then put its hash and reward on the
                board.
              </p>
              <form onSubmit={(e) => void post(e)}>
                <label>
                  Specification hash
                  <input
                    name="specHash"
                    value={spec}
                    onChange={(e) => {
                      setSpec(e.target.value);
                      setPostError("");
                      setInvalidField("");
                    }}
                    placeholder="0x… (32 bytes)"
                    spellCheck={false}
                    aria-invalid={invalidField === "specHash"}
                    aria-describedby="post-error"
                    required
                  />
                </label>
                <div className="two-fields">
                  <label>
                    Reward (ETH)
                    <input
                      name="reward"
                      aria-invalid={invalidField === "reward"}
                      aria-describedby="post-error"
                      inputMode="decimal"
                      value={reward}
                      onChange={(e) => {
                        setReward(e.target.value);
                        setPostError("");
                        setInvalidField("");
                      }}
                      required
                    />
                  </label>
                  <label>
                    Commit window (hours)
                    <input
                      name="hours"
                      aria-invalid={invalidField === "hours"}
                      aria-describedby="post-error"
                      type="number"
                      min="1.02"
                      max="720"
                      step="0.01"
                      value={hours}
                      onChange={(e) => {
                        setHours(e.target.value);
                        setPostError("");
                        setInvalidField("");
                      }}
                      required
                    />
                  </label>
                </div>
                <p className="hint">
                  Minimum 0.0001 ETH · up to 30 days.
                  <br />
                  The reward is escrowed when you post; gas is additional.
                </p>
                <button className="primary" type="submit" disabled={!s.ready}>
                  Post task <span aria-hidden="true">↗</span>
                </button>
                <p className="hint centered">
                  {!s.account
                    ? "Connect your wallet to post."
                    : !s.walletReady
                      ? `Switch to ${network.name} to post.`
                      : !s.verified
                        ? "Waiting for verified contract data."
                        : "Review the amount in your wallet before confirming."}
                </p>
                <p id="post-error" className="error" role="alert">
                  {postError}
                </p>
              </form>
              <details>
                <summary>Need a specification hash?</summary>
                <label>
                  Exact brief text
                  <textarea
                    value={hashText}
                    onChange={(e) => setHashText(e.target.value)}
                    rows={4}
                  />
                </label>
                <p className="hint">
                  Keccak-256 of the exact UTF-8 text. Keep the original text and
                  share it with workers.
                </p>
                <button
                  onClick={() => setSpec(keccak256(toBytes(hashText)))}
                  disabled={!hashText}
                >
                  Use brief hash
                </button>
              </details>
            </section>
            <TokenPanel runtime={runtime} state={s} />
            <div className="faucet-note">
              <span aria-hidden="true">↳</span>
              <p>
                Need test ETH?
                <br />
                <a href={network.faucets[0]} target="_blank" rel="noreferrer">
                  Open the {network.name} faucet ↗
                </a>
              </p>
            </div>
          </aside>
        </div>
        <footer>
          <div className="section-heading">
            <a className="brand" href="#main">
              taskboard<span className="brand-label">/ swarm lab</span>
            </a>
            <span>Small experiments, on-chain.</span>
          </div>
          <details>
            <summary>Deployment & connected wallet</summary>
            <p className="mono">Wallet: {s.account || "Not connected"}</p>
            {runtime.config.contracts.map((c) => (
              <p key={c.name}>
                {c.name}
                <br />
                <a
                  className="mono"
                  href={`${network.explorer}/address/${c.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.address} ↗
                </a>
              </p>
            ))}
            <p className="mono">
              Chain: {runtime.config.chainId}
              <br />
              Source: {runtime.config.sourceCommit}
              <br />
              Attestation: {runtime.config.attestationHash}
            </p>
            <a href="./imd-deployment.json" target="_blank" rel="noreferrer">
              View deployment manifest
            </a>
            <p className="hint">
              No owner, admin, fee or upgrade path. Do not send ETH directly to
              the board contract; use Post task.
            </p>
          </details>
        </footer>
      </main>
    </>
  );
}
