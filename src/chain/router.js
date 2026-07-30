// SwapRouter da Uniswap V3 e WETH.
//
// Existem duas variantes de exactInputSingle em circulação: a original tem o
// campo `deadline` na struct, a SwapRouter02 não tem. A factory da pons diz qual
// usar através de `routerRequiresDeadline` na LaunchConfig — o agente lê esse
// flag em vez de adivinhar, porque errar a struct faz a chamada reverter.
export const ROUTER_ABI_WITH_DEADLINE = [
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

export const ROUTER_ABI_NO_DEADLINE = [
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

export const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'guy', type: 'address' }, { name: 'wad', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
];

export const routerAbi = (requiresDeadline) =>
  (requiresDeadline ? ROUTER_ABI_WITH_DEADLINE : ROUTER_ABI_NO_DEADLINE);

export const routerItem = (requiresDeadline) => routerAbi(requiresDeadline)[0];

/** Monta os parâmetros do exactInputSingle na ordem que a variante espera. */
export function swapParams({
  tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum,
  requiresDeadline, deadlineSeconds = 900, now,
}) {
  const base = [tokenIn, tokenOut, BigInt(fee), recipient];
  const tail = [BigInt(amountIn), BigInt(amountOutMinimum), 0n];   // sqrtPriceLimit 0 = sem limite
  if (!requiresDeadline) return [[...base, ...tail]];
  const deadline = BigInt(now ?? Math.floor(Date.now() / 1000)) + BigInt(deadlineSeconds);
  return [[...base, deadline, ...tail]];
}

export const wethItem = (name) => WETH_ABI.find((i) => i.name === name);
