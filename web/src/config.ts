import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
  type EIP1193Provider,
} from "viem";
export type Provider = EIP1193Provider & {
  on?: (event: string, cb: (...args: any[]) => void) => void;
  removeListener?: (event: string, cb: (...args: any[]) => void) => void;
};
declare global {
  interface Window {
    ethereum?: Provider;
  }
}
export type Deployment = {
  version: number;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: {
    name: string;
    address: Address;
    abiHash: string;
    abiPath: string;
  }[];
  network: {
    chainId: number;
    name: string;
    testnet: boolean;
    rpcUrls: string[];
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    faucets: string[];
    uniswapV4: {
      poolManager: Address;
      universalRouter: Address;
      quoter: Address;
      stateView: Address;
      positionManager: Address;
      permit2: Address;
    };
  };
  walletAddChain: {
    chainId: `0x${string}`;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
  pool: { pairedCurrency: Address; fee: number; tickSpacing: number };
  token: { name: string; symbol: string; decimals: number; contract: string };
  deploymentBlocks: Record<string, number>;
};
export function canonical(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
}
export function hashAbi(abi: Abi) {
  return keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
}
export async function loadRuntime() {
  const response = await fetch("./imd-deployment.json");
  if (!response.ok)
    throw Error("Deployment configuration could not load. Reload this page.");
  const config: Deployment = await response.json();
  if (
    config.version !== 1 ||
    config.chainId !== config.network.chainId ||
    Number(BigInt(config.walletAddChain.chainId)) !== config.chainId
  )
    throw Error("Deployment chain mismatch. Transactions are disabled.");
  const contracts: Record<string, { address: Address; abi: Abi }> = {};
  for (const c of config.contracts) {
    if (
      !/^[\w/-]+\.json$/.test(c.abiPath) ||
      c.abiPath.split("/").includes("..") ||
      c.abiPath.startsWith("/")
    )
      throw Error("Unsafe ABI path");
    const r = await fetch(`./${c.abiPath}`);
    if (!r.ok) throw Error(`Cannot load ${c.name} ABI. Reload this page.`);
    const abi: Abi = await r.json();
    if (!Array.isArray(abi) || hashAbi(abi) !== c.abiHash)
      throw Error(
        `ABI verification failed for ${c.name}. Transactions are disabled.`,
      );
    contracts[c.name] = { address: c.address, abi };
  }
  if (!contracts.SwarmJobBoard || !contracts[config.token.contract])
    throw Error("Required contract missing");
  const chain = defineChain({
    id: config.chainId,
    name: config.network.name,
    nativeCurrency: config.network.nativeCurrency,
    rpcUrls: { default: { http: config.network.rpcUrls } },
    blockExplorers: {
      default: { name: "Explorer", url: config.network.explorer },
    },
    testnet: config.network.testnet,
  });
  const client: PublicClient<Transport, Chain> = createPublicClient({
    chain,
    transport: fallback(
      config.network.rpcUrls.map((url) =>
        http(url, { timeout: 10000, retryCount: 0 }),
      ),
      { retryCount: 0 },
    ),
  });
  return { config, contracts, chain, client };
}
export type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
export function walletFor(
  runtime: Runtime,
  provider: Provider,
  account: Address,
) {
  return createWalletClient({
    account,
    chain: runtime.chain,
    transport: custom(provider),
  });
}
export async function switchNetwork(provider: Provider, config: Deployment) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.walletAddChain.chainId }],
    });
  } catch (e) {
    const err = e as {
      code?: number;
      message?: string;
      data?: { originalError?: { code?: number } };
    };
    if (
      err.code !== 4902 &&
      err.data?.originalError?.code !== 4902 &&
      !/unknown chain|unrecognized chain|not added/i.test(err.message || "")
    )
      throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [config.walletAddChain],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.walletAddChain.chainId }],
    });
  }
}
export async function verifyCode(runtime: Runtime) {
  if ((await runtime.client.getChainId()) !== runtime.config.chainId)
    throw Error("RPC chain mismatch. Try refreshing.");
  for (const c of Object.values(runtime.contracts)) {
    const code = await runtime.client.getCode({ address: c.address });
    if (!code || code === "0x")
      throw Error("Contract code is missing. Transactions remain disabled.");
  }
}
