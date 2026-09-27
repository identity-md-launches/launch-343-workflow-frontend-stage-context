import { useCallback, useEffect, useRef, useState } from "react";
import {
  custom,
  createPublicClient,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { type Runtime, verifyCode, walletFor, switchNetwork } from "./config";
import { message, type Task } from "./model";
export type Tx = { label: string; stage: string; hash?: Hex; error?: boolean };
export function useBoard(runtime: Runtime) {
  const [account, setAccount] = useState<Address>(),
    [chainId, setChainId] = useState<number>(),
    [busy, setBusy] = useState(false),
    [tx, setTx] = useState<Tx>(),
    [error, setError] = useState("");
  const [verified, setVerified] = useState(false),
    [loading, setLoading] = useState(true),
    [tasks, setTasks] = useState<Task[]>([]),
    [count, setCount] = useState(0n),
    [now, setNow] = useState(0n),
    [block, setBlock] = useState(0n),
    [updated, setUpdated] = useState(0),
    [page, setPage] = useState(0);
  const [withdrawable, setWithdrawable] = useState<bigint>(),
    [balance, setBalance] = useState<bigint>(),
    [tokenBalance, setTokenBalance] = useState<bigint>(),
    [decimals, setDecimals] = useState(runtime.config.token.decimals);
  const [reader, setReader] = useState(runtime.client);
  const lock = useRef(false),
    generation = useRef(0);
  const board = runtime.contracts.SwarmJobBoard,
    token = runtime.contracts[runtime.config.token.contract];
  const walletReady = !!account && chainId === runtime.config.chainId;
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    setError("");
    try {
      await verifyCode({ ...runtime, client: reader });
      const [latest, total, decimalValue] = await Promise.all([
        reader.getBlock(),
        reader.readContract({ ...board, functionName: "taskCount" }),
        reader.readContract({ ...token, functionName: "decimals" }),
      ]);
      const n = total as bigint,
        end = n - BigInt(page * 8),
        ids = Array.from(
          { length: Number(end > 0n ? (end > 8n ? 8n : end) : 0n) },
          (_, i) => end - BigInt(i),
        );
      const list = await Promise.all(
        ids.map(async (id) => ({
          ...((await reader.readContract({
            ...board,
            functionName: "task",
            args: [id],
          })) as Omit<Task, "id">),
          id,
        })),
      );
      const values = account
        ? await Promise.all([
            reader.readContract({
              ...board,
              functionName: "withdrawable",
              args: [account],
            }),
            reader.getBalance({ address: account }),
            reader.readContract({
              ...token,
              functionName: "balanceOf",
              args: [account],
            }),
          ])
        : undefined;
      if (run !== generation.current) return;
      setTasks(list);
      setCount(n);
      setNow(latest.timestamp);
      setBlock(latest.number);
      setDecimals(Number(decimalValue));
      setWithdrawable(values?.[0] as bigint | undefined);
      setBalance(values?.[1] as bigint | undefined);
      setTokenBalance(values?.[2] as bigint | undefined);
      setVerified(true);
      setUpdated(Date.now());
    } catch (e) {
      if (run === generation.current) {
        setError(message(e));
        setVerified(false);
        setUpdated(0);
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [runtime, reader, account, page, board, token]);
  useEffect(() => {
    setUpdated(0);
    setWithdrawable(undefined);
    setBalance(undefined);
    setTokenBalance(undefined);
    void refresh();
    const i = setInterval(() => void refresh(), 30000);
    return () => {
      clearInterval(i);
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const p = window.ethereum;
    if (!p) return;
    const accounts = (items: Address[]) => {
      setAccount(items[0]);
      setUpdated(0);
      setTx(undefined);
    };
    const chain = (id: string) => {
      setChainId(Number(BigInt(id)));
      setUpdated(0);
      setTx(undefined);
    };
    const disconnected = () => {
      setAccount(undefined);
      setUpdated(0);
    };
    p.request({ method: "eth_accounts" })
      .then(accounts)
      .catch(() => {});
    p.request({ method: "eth_chainId" })
      .then(chain)
      .catch(() => {});
    p.on?.("accountsChanged", accounts);
    p.on?.("chainChanged", chain);
    p.on?.("disconnect", disconnected);
    return () => {
      p.removeListener?.("accountsChanged", accounts);
      p.removeListener?.("chainChanged", chain);
      p.removeListener?.("disconnect", disconnected);
    };
  }, []);
  const connect = async () => {
    setError("");
    try {
      if (!window.ethereum)
        throw Error(
          "No browser wallet found. Open this page in an Ethereum wallet browser, or install a browser wallet, then reload.",
        );
      setAccount(
        (await window.ethereum.request({ method: "eth_requestAccounts" }))[0],
      );
      setChainId(
        Number(
          BigInt(await window.ethereum.request({ method: "eth_chainId" })),
        ),
      );
    } catch (e) {
      setError(message(e));
    }
  };
  const switchChain = async () => {
    try {
      if (!window.ethereum) return;
      await switchNetwork(window.ethereum, runtime.config);
      setChainId(
        Number(
          BigInt(await window.ethereum.request({ method: "eth_chainId" })),
        ),
      );
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  };
  const assertWallet = async () => {
    if (
      !account ||
      !window.ethereum ||
      !verified ||
      !updated ||
      Date.now() - updated > 90000
    )
      throw Error(
        "Connect your wallet and refresh verified chain data before continuing.",
      );
    const [chain, accounts] = await Promise.all([
      window.ethereum.request({ method: "eth_chainId" }),
      window.ethereum.request({ method: "eth_accounts" }),
    ]);
    if (
      Number(BigInt(chain)) !== runtime.config.chainId ||
      accounts[0]?.toLowerCase() !== account.toLowerCase()
    )
      throw Error("Wallet account or network changed. Refresh and try again.");
    return walletFor(runtime, window.ethereum, account);
  };
  const transact = async (
    label: string,
    contract: { address: Address; abi: Abi },
    functionName: string,
    args: readonly unknown[] = [],
    value = 0n,
  ) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setTx({ label, stage: "Checking transaction…" });
    try {
      const wallet = await assertWallet();
      const { request } = await reader.simulateContract({
        ...contract,
        functionName,
        args,
        account: account!,
        value,
      });
      await assertWallet();
      setTx({ label, stage: "Confirm in your wallet" });
      const hash = await wallet.writeContract(request);
      setTx({ label, stage: "Waiting for confirmation…", hash });
      const receipt = await reader.waitForTransactionReceipt({
        hash,
        timeout: 120000,
      });
      if (receipt.status !== "success")
        throw Error(
          "Transaction reverted. Refresh the task state before retrying.",
        );
      setTx({ label, stage: "Confirmed", hash });
      await refresh();
      return true;
    } catch (e) {
      setTx((previous) => ({
        label,
        hash: previous?.hash,
        stage: message(e),
        error: true,
      }));
      return false;
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  const useWalletRpc = () => {
    if (window.ethereum && walletReady)
      setReader(
        createPublicClient({
          chain: runtime.chain,
          transport: custom(window.ethereum),
        }),
      );
  };
  return {
    account,
    chainId,
    busy,
    tx,
    error,
    setError,
    verified,
    loading,
    tasks,
    count,
    now,
    block,
    updated,
    page,
    setPage,
    withdrawable,
    balance,
    tokenBalance,
    decimals,
    reader,
    refresh,
    connect,
    switchChain,
    transact,
    walletReady,
    useWalletRpc,
    ready: walletReady && verified && !!updated && !loading && !busy,
  };
}
export type BoardState = ReturnType<typeof useBoard>;
