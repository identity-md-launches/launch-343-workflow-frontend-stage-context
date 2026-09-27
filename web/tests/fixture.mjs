import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseAbiParameters,
  toHex,
  keccak256,
} from "viem";
const manifest = JSON.parse(
  readFileSync(new URL("../../dist/imd-deployment.json", import.meta.url)),
);
const contracts = Object.fromEntries(
  manifest.contracts.map((c) => [
    c.name,
    {
      ...c,
      abi: JSON.parse(
        readFileSync(new URL(`../../dist/${c.abiPath}`, import.meta.url)),
      ),
    },
  ]),
);
const board = contracts.SwarmJobBoard,
  token = contracts.LaunchToken,
  net = manifest.network.uniswapV4;
const quoteAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const permitAbi = parseAbi([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
]);
const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
export const worker = "0x1111111111111111111111111111111111111111",
  poster = "0x2222222222222222222222222222222222222222";
const z = "0x" + "0".repeat(64),
  hash = "0x" + "ab".repeat(32),
  blockHash = "0x" + "42".repeat(32);
export function fixture() {
  const f = {
    now: 1800000000n,
    height: BigInt(manifest.deploymentBlocks.SwarmJobBoard) + 10n,
    tasks: [],
    subs: new Map(),
    credit: 500000000000000n,
    tokenAllowance: 0n,
    permitAllowance: 0n,
    permitExpiry: 0,
    account: worker,
    chain: "0x1",
    connected: false,
    added: false,
    missingCode: false,
    failRpc: false,
    reject: false,
    simulateFail: false,
    requests: [],
    sent: [],
    receipts: new Map(),
    events: [],
  };
  f.tasks = [
    {
      poster,
      deadline: f.now + 86400n,
      status: 1,
      specHash: hash,
      reward: 1000000000000000n,
      commitCount: 0n,
      revealedCount: 0n,
      share: 0n,
    },
  ];
  const submission = (id, account) =>
    f.subs.get(`${id}:${account.toLowerCase()}`) || {
      commitment: z,
      resultHash: z,
      revealed: false,
      splitClaimed: false,
    };
  function decode(tx) {
    const c = tx.to.toLowerCase();
    let abi =
      c === board.address
        ? board.abi
        : c === token.address
          ? token.abi
          : c === net.quoter
            ? quoteAbi
            : c === net.permit2
              ? permitAbi
              : c === net.universalRouter
                ? routerAbi
                : undefined;
    if (!abi) throw Error(`Unexpected contract ${tx.to}`);
    return { ...decodeFunctionData({ abi, data: tx.data }), abi };
  }
  function call(tx) {
    const { functionName: fn, args = [], abi } = decode(tx);
    let result;
    if (fn === "taskCount") result = BigInt(f.tasks.length);
    else if (fn === "task") result = f.tasks[Number(args[0]) - 1];
    else if (fn === "submission") result = submission(args[0], args[1]);
    else if (fn === "withdrawable") result = f.credit;
    else if (fn === "decimals") result = 18;
    else if (fn === "balanceOf") result = 1000000000000000000000n;
    else if (fn === "allowance")
      result =
        tx.to.toLowerCase() === net.permit2
          ? [f.permitAllowance, f.permitExpiry, 0]
          : f.tokenAllowance;
    else if (fn === "quoteExactInputSingle")
      result = [args[0].exactAmount * 100n, 100000n];
    else {
      if (f.simulateFail)
        throw {
          code: 3,
          message: "execution reverted: fixture simulation failure",
        };
      if (fn === "post") result = BigInt(f.tasks.length + 1);
      else if (
        ["transfer", "transferFrom"].includes(fn) ||
        (fn === "approve" && tx.to.toLowerCase() === token.address)
      )
        result = true;
      else return "0x";
    }
    return encodeFunctionResult({ abi, functionName: fn, result });
  }
  function send(tx) {
    const { functionName: fn, args = [] } = decode(tx);
    f.sent.push({ fn, args, to: tx.to, value: tx.value || "0x0" });
    const h = keccak256(toHex(`fixture-${f.sent.length}`));
    const t = f.tasks[Number(args[0]) - 1];
    if (fn === "post")
      f.tasks.push({
        poster: f.account,
        deadline: args[1],
        status: 1,
        specHash: args[0],
        reward: BigInt(tx.value),
        commitCount: 0n,
        revealedCount: 0n,
        share: 0n,
      });
    if (fn === "commit") {
      t.commitCount++;
      f.subs.set(`${args[0]}:${f.account}`, {
        commitment: args[1],
        resultHash: z,
        revealed: false,
        splitClaimed: false,
      });
    }
    if (fn === "reveal") {
      const sub = submission(args[0], f.account);
      sub.revealed = true;
      sub.resultHash = args[1];
      t.revealedCount++;
      f.events.push({ id: args[0], worker: f.account, resultHash: args[1] });
    }
    if (fn === "accept") {
      t.status = 2;
      f.credit += t.reward;
    }
    if (fn === "rejectAll") {
      t.status = 3;
      f.credit += t.reward;
    }
    if (fn === "cancel") {
      t.status = 4;
      f.credit += t.reward;
    }
    if (fn === "finalize") {
      t.status = 5;
      t.share = t.revealedCount ? t.reward / t.revealedCount : 0n;
    }
    if (fn === "claimSplit") {
      submission(args[0], f.account).splitClaimed = true;
      f.credit += t.share;
    }
    if (fn === "withdraw") f.credit = 0n;
    if (fn === "approve") {
      if (tx.to.toLowerCase() === token.address) f.tokenAllowance = args[1];
      else {
        f.permitAllowance = args[2];
        f.permitExpiry = args[3];
      }
    }
    f.receipts.set(h, {
      transactionHash: h,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: toHex(f.height),
      from: f.account,
      to: tx.to,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [],
      logsBloom: "0x" + "0".repeat(512),
      status: "0x1",
      effectiveGasPrice: "0x1",
      type: "0x2",
    });
    return h;
  }
  f.rpc = async ({ method, params = [] }) => {
    f.requests.push({ method, params });
    if (f.failRpc) throw { code: -32000, message: "Fixture RPC unavailable" };
    if (method === "eth_chainId") return manifest.walletAddChain.chainId;
    if (method === "eth_getCode") return f.missingCode ? "0x" : "0x6001600055";
    if (method === "eth_getBalance") return toHex(1000000000000000000n);
    if (method === "eth_blockNumber") return toHex(f.height);
    if (method === "eth_getBlockByNumber")
      return {
        number: toHex(f.height),
        hash: blockHash,
        parentHash: blockHash,
        timestamp: toHex(f.now),
        nonce: "0x0000000000000000",
        sha3Uncles: blockHash,
        logsBloom: "0x" + "0".repeat(512),
        transactionsRoot: blockHash,
        stateRoot: blockHash,
        receiptsRoot: blockHash,
        miner: poster,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        transactions: [],
        uncles: [],
        baseFeePerGas: "0x1",
        mixHash: blockHash,
      };
    if (method === "eth_call") return call(params[0]);
    if (method === "eth_getTransactionReceipt")
      return f.receipts.get(params[0]) || null;
    if (method === "eth_getLogs")
      return f.events
        .filter(
          (e) =>
            !params[0].topics[1] ||
            toHex(e.id, { size: 32 }) === params[0].topics[1],
        )
        .map((e, i) => ({
          address: board.address,
          topics: encodeEventTopics({
            abi: board.abi,
            eventName: "Revealed",
            args: { taskId: e.id, worker: e.worker },
          }),
          data: encodeAbiParameters(parseAbiParameters("bytes32"), [
            e.resultHash,
          ]),
          blockNumber: toHex(f.height),
          transactionHash: blockHash,
          transactionIndex: "0x0",
          blockHash,
          logIndex: toHex(i),
          removed: false,
        }));
    throw Error(`Unmocked RPC method: ${method}`);
  };
  f.wallet = async ({ method, params = [] }) => {
    f.requests.push({ method, params });
    if (method === "eth_chainId") return f.chain;
    if (method === "eth_accounts") return f.connected ? [f.account] : [];
    if (method === "eth_requestAccounts") {
      if (f.reject) throw { code: 4001, message: "User rejected request" };
      f.connected = true;
      return [f.account];
    }
    if (method === "wallet_switchEthereumChain") {
      if (f.reject) throw { code: 4001, message: "User rejected request" };
      if (!f.added) throw { code: 4902, message: "Unknown chain" };
      f.chain = params[0].chainId;
      return null;
    }
    if (method === "wallet_addEthereumChain") {
      f.added = true;
      return null;
    }
    if (method === "eth_sendTransaction") {
      if (f.reject) throw { code: 4001, message: "User rejected request" };
      return send(params[0]);
    }
    return f.rpc({ method, params });
  };
  return f;
}
export { manifest, board, token, net, hash, z };
