import { useEffect, useState } from "react";
import { formatUnits, isAddress, zeroAddress, type Address } from "viem";
import type { Runtime } from "./config";
import type { BoardState } from "./useBoard";
import { message, parseAmount } from "./model";
import {
  minimumOutput,
  permitAbi,
  poolKey,
  quoterAbi,
  routerAbi,
  swapInput,
} from "./swap";
export function TokenPanel({
  runtime,
  state: s,
}: {
  runtime: Runtime;
  state: BoardState;
}) {
  const token = runtime.contracts[runtime.config.token.contract],
    net = runtime.config.network;
  const [buy, setBuy] = useState(true),
    [amount, setAmount] = useState("0.001"),
    [slip, setSlip] = useState("0.5"),
    [quote, setQuote] = useState<{
      out: bigint;
      minimum: bigint;
      input: bigint;
      time: number;
    }>(),
    [error, setError] = useState(""),
    [quoting, setQuoting] = useState(false),
    [allowance, setAllowance] = useState(0n),
    [permit, setPermit] = useState(0n),
    [permitExpiry, setPermitExpiry] = useState(0),
    [transferTo, setTransferTo] = useState(""),
    [transferAmount, setTransferAmount] = useState(""),
    [spender, setSpender] = useState(""),
    [spendAmount, setSpendAmount] = useState(""),
    [from, setFrom] = useState(""),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    setQuote(undefined);
    setError("");
  }, [buy, amount, slip, s.account, s.chainId]);
  useEffect(() => {
    let active = true;
    setAllowance(0n);
    setPermit(0n);
    setPermitExpiry(0);
    if (!s.account) return;
    Promise.all([
      s.reader.readContract({
        ...token,
        functionName: "allowance",
        args: [s.account, net.uniswapV4.permit2],
      }),
      s.reader.readContract({
        address: net.uniswapV4.permit2,
        abi: permitAbi,
        functionName: "allowance",
        args: [s.account, token.address, net.uniswapV4.universalRouter],
      }),
    ])
      .then(([a, p]) => {
        if (active) {
          setAllowance(a as bigint);
          setPermit(p[0]);
          setPermitExpiry(p[1]);
        }
      })
      .catch((e) => {
        if (active) setError(`Cannot read token approvals. ${message(e)}`);
      });
    return () => {
      active = false;
    };
  }, [s.account, s.updated, s.reader, token, net]);
  const supported = runtime.config.pool.pairedCurrency === zeroAddress;
  const fresh = !!quote && clock - quote.time < 60000;
  const needsToken = !!quote && !buy && allowance < quote.input,
    needsPermit =
      !!quote &&
      !buy &&
      (permit < quote.input || permitExpiry < Math.floor(clock / 1000) + 120);
  async function getQuote() {
    setQuoting(true);
    setError("");
    setQuote(undefined);
    try {
      const input = parseAmount(
        amount,
        buy ? net.nativeCurrency.decimals : s.decimals,
      );
      if (input <= 0n || input >= 2n ** 128n)
        throw Error("Enter a positive amount smaller than the swap limit.");
      minimumOutput(1n, slip);
      const key = poolKey(runtime),
        currency = buy ? runtime.config.pool.pairedCurrency : token.address;
      const { result } = await s.reader.simulateContract({
        address: net.uniswapV4.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: key,
            zeroForOne: currency.toLowerCase() === key.currency0.toLowerCase(),
            exactAmount: input,
            hookData: "0x",
          },
        ],
        account: s.account,
      });
      if (result[0] <= 0n)
        throw Error(
          "No output available. Try a smaller amount or wait for liquidity.",
        );
      const minimum = minimumOutput(result[0], slip);
      if (minimum <= 0n || minimum >= 2n ** 128n)
        throw Error("Quoted output is outside supported swap limits.");
      setQuote({ out: result[0], minimum, input, time: Date.now() });
    } catch (e) {
      setError(`Quote unavailable. ${message(e)}`);
    } finally {
      setQuoting(false);
    }
  }
  async function swap() {
    if (!quote || !fresh) return;
    const ok = await s.transact(
      `Swap ${buy ? "ETH for TASK" : "TASK for ETH"}`,
      { address: net.uniswapV4.universalRouter, abi: routerAbi },
      "execute",
      [
        "0x10",
        [swapInput(runtime, buy, quote.input, quote.minimum)],
        BigInt(Math.floor(Date.now() / 1000) + 1200),
      ],
      buy ? quote.input : 0n,
    );
    if (ok) setQuote(undefined);
  }
  async function tokenAction(fn: "transfer" | "approve" | "transferFrom") {
    setError("");
    try {
      const target = fn === "approve" ? spender : transferTo;
      if (!isAddress(target) || target === zeroAddress)
        throw Error("Enter a valid, nonzero recipient or spender address.");
      const value = parseAmount(
        fn === "approve" ? spendAmount : transferAmount,
        s.decimals,
      );
      if (value < 0n || (fn !== "approve" && value === 0n))
        throw Error(
          "Enter a positive amount. Approvals may be zero to revoke.",
        );
      if (fn === "transferFrom" && !isAddress(from))
        throw Error(
          "Enter the token owner address. The owner must have approved this wallet.",
        );
      await s.transact(
        fn === "approve"
          ? "Set TASK spending approval"
          : fn === "transferFrom"
            ? "Transfer approved TASK"
            : "Send TASK",
        token,
        fn,
        fn === "transferFrom"
          ? [from as Address, target, value]
          : [target, value],
      );
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <section id="token" className="panel token-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Launch token</span>
          <h2>Swap TASK</h2>
        </div>
        <span className="badge neutral">Uniswap v4</span>
      </div>
      <p className="hint">
        TASK is separate from task rewards. This pool trades test ETH and TASK;
        quotes depend on available liquidity.
      </p>
      <p className="balance-line">
        Wallet balance{" "}
        <b>
          {s.tokenBalance === undefined
            ? "—"
            : formatUnits(s.tokenBalance, s.decimals)}{" "}
          TASK
        </b>
      </p>
      {!supported && (
        <p className="error">
          Swaps are unavailable: this interface supports the attested native ETH
          pair only.
        </p>
      )}
      <label htmlFor="swap-direction">Direction</label>
      <select
        id="swap-direction"
        value={buy ? "buy" : "sell"}
        onChange={(e) => setBuy(e.target.value === "buy")}
        disabled={s.busy || quoting}
      >
        <option value="buy">Buy TASK with ETH</option>
        <option value="sell">Sell TASK for ETH</option>
      </select>
      <div className="two-fields">
        <label>
          Pay ({buy ? "ETH" : "TASK"})
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={s.busy || quoting}
          />
        </label>
        <label>
          Slippage (%)
          <input
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            value={slip}
            onChange={(e) => setSlip(e.target.value)}
            disabled={s.busy || quoting}
          />
        </label>
      </div>
      <button
        onClick={() => void getQuote()}
        disabled={!supported || !s.verified || quoting || s.busy}
      >
        {quoting ? "Getting quote…" : "Get quote"}
      </button>
      {quote && (
        <div className="quote">
          <dl className="facts">
            <div>
              <dt>Estimated receive</dt>
              <dd>
                {formatUnits(
                  quote.out,
                  buy ? s.decimals : net.nativeCurrency.decimals,
                )}{" "}
                {buy ? "TASK" : "ETH"}
              </dd>
            </div>
            <div>
              <dt>Minimum receive</dt>
              <dd>
                {formatUnits(
                  quote.minimum,
                  buy ? s.decimals : net.nativeCurrency.decimals,
                )}{" "}
                {buy ? "TASK" : "ETH"}
              </dd>
            </div>
          </dl>
          <p className="hint">
            Rate: 1 {buy ? "ETH" : "TASK"} ≈{" "}
            {(
              Number(
                formatUnits(
                  quote.out,
                  buy ? s.decimals : net.nativeCurrency.decimals,
                ),
              ) / Number(amount)
            ).toLocaleString(undefined, { maximumSignificantDigits: 7 })}{" "}
            {buy ? "TASK" : "ETH"}. Quote{" "}
            {fresh
              ? "expires after 60 seconds."
              : "expired. Get a fresh quote."}{" "}
            Swap deadline: 20 minutes. Gas is additional.
          </p>
          {!buy && (
            <ol className="approval-steps">
              <li>
                <p>Allow Permit2 to spend exactly {amount} TASK.</p>
                <button
                  disabled={!s.ready || !fresh || !needsToken}
                  onClick={() =>
                    void s.transact(
                      "Approve TASK for Permit2",
                      token,
                      "approve",
                      [net.uniswapV4.permit2, quote.input],
                    )
                  }
                >
                  {needsToken ? "1. Approve TASK" : "1. TASK approved"}
                </button>
              </li>
              <li>
                <p>Allow the router to use {amount} TASK for 30 minutes.</p>
                <button
                  disabled={!s.ready || !fresh || needsToken || !needsPermit}
                  onClick={() =>
                    void s.transact(
                      "Approve router in Permit2",
                      { address: net.uniswapV4.permit2, abi: permitAbi },
                      "approve",
                      [
                        token.address,
                        net.uniswapV4.universalRouter,
                        quote.input,
                        Math.floor(Date.now() / 1000) + 1800,
                      ],
                    )
                  }
                >
                  {needsPermit ? "2. Approve router" : "2. Router approved"}
                </button>
              </li>
            </ol>
          )}
          <p className="hint">
            {buy ? "Native ETH needs no approval. " : ""}The swap is simulated
            before your wallet asks you to sign.
          </p>
          <button
            disabled={!s.ready || !fresh || needsToken || needsPermit}
            onClick={() => void swap()}
          >
            Swap {buy ? "ETH for TASK" : "TASK for ETH"}
          </button>
        </div>
      )}
      <p className="error" role="alert">
        {error}
      </p>
      <details>
        <summary>Send TASK & manage approvals</summary>
        <p className="hint">
          Sending TASK moves tokens immediately. A spending approval lets the
          named address transfer that many tokens. Verify the full address in
          your wallet.
        </p>
        <label>
          Recipient address
          <input
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <label>
          TASK amount
          <input
            inputMode="decimal"
            value={transferAmount}
            onChange={(e) => setTransferAmount(e.target.value)}
          />
        </label>
        <button
          disabled={!s.ready}
          onClick={() => void tokenAction("transfer")}
        >
          Send TASK
        </button>
        <label>
          Spender address
          <input
            value={spender}
            onChange={(e) => setSpender(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <label>
          TASK allowance (0 to revoke)
          <input
            inputMode="decimal"
            value={spendAmount}
            onChange={(e) => setSpendAmount(e.target.value)}
          />
        </label>
        <button disabled={!s.ready} onClick={() => void tokenAction("approve")}>
          Set spending approval
        </button>
        <label>
          Token owner address
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <p className="hint">
          Transfer from an owner who approved your wallet, using the recipient
          and amount above.
        </p>
        <button
          disabled={!s.ready}
          onClick={() => void tokenAction("transferFrom")}
        >
          Transfer approved TASK
        </button>
      </details>
    </section>
  );
}
