import {
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
} from "viem";
import type { Runtime } from "./config";
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
export const permitAbi = parseAbi([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
]);
export const keyType =
  "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export function poolKey(runtime: Runtime) {
  const pair = runtime.config.pool.pairedCurrency,
    token = runtime.contracts[runtime.config.token.contract].address;
  const [currency0, currency1] = [pair, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  );
  return {
    currency0,
    currency1,
    fee: runtime.config.pool.fee,
    tickSpacing: runtime.config.pool.tickSpacing,
    hooks: zeroAddress,
  };
}
export function swapInput(
  runtime: Runtime,
  buy: boolean,
  amount: bigint,
  minimum: bigint,
) {
  const key = poolKey(runtime),
    token = runtime.contracts[runtime.config.token.contract].address;
  const input: Address = buy ? runtime.config.pool.pairedCurrency : token,
    output: Address = buy ? token : runtime.config.pool.pairedCurrency;
  const params = [
    encodeAbiParameters(
      parseAbiParameters(
        `(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`,
      ),
      [
        {
          poolKey: key,
          zeroForOne: input.toLowerCase() === key.currency0.toLowerCase(),
          amountIn: amount,
          amountOutMinimum: minimum,
          hookData: "0x",
        },
      ],
    ),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [input, amount]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [
      output,
      minimum,
    ]),
  ];
  return encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [
    "0x060c0f",
    params,
  ]);
}
export function minimumOutput(out: bigint, slippage: string) {
  const value = Number(slippage);
  if (!Number.isFinite(value) || value < 0.1 || value > 5)
    throw Error("Choose slippage between 0.1% and 5%.");
  return (out * BigInt(10000 - Math.round(value * 100))) / 10000n;
}
