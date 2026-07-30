// Configuração da rede e endereços — fonte: docs.ponsfamily.com/docs (seções
// #network e #contracts) e ABI verificada da factory no Blockscout.

// Duas redes. PONS_NETWORK=testnet muda tudo de uma vez — chain id, RPC e
// explorer — para que a trava de chainId do executor continue significando algo.
// Os endereços dos contratos da pons na testnet precisam ser confirmados com a
// equipe deles; por isso cada um pode ser sobrescrito por variável de ambiente.
export const NETWORKS = {
  mainnet: {
    id: 4663,
    name: 'Robinhood Chain',
    publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
  },
  testnet: {
    id: 46630,
    name: 'Robinhood Chain Testnet',
    publicRpc: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
};

const NETWORK = process.env.PONS_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const NET = NETWORKS[NETWORK];

export const CHAIN = {
  id: NET.id,
  network: NETWORK,
  name: NET.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [process.env.PONS_RPC_URL, NET.publicRpc].filter(Boolean),
  explorer: NET.explorer,
  isTestnet: NETWORK === 'testnet',
};

export const CONTRACTS = {
  // Factory ativa na mainnet (lançamentos a partir do bloco 8991118).
  factory: process.env.PONS_FACTORY || '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  factoryDeployBlock: BigInt(process.env.PONS_FACTORY_BLOCK || '8991118'),
  locker: process.env.PONS_LOCKER || '0x736D76699C26D0d966744cAe304C000d471f7F35',
  v3Factory: process.env.PONS_V3_FACTORY || '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  weth: process.env.PONS_WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

export const PROTOCOL = {
  poolFee: 10000,          // 1% (basis points do Uniswap V3)
  launchFeeEth: '0.0005',
  fixedSupply: 1_000_000_000n,
  creatorFeeShareBps: 7000,      // 70% criador / 30% protocolo (factory ativa)
  graduationThresholdEth: '4.2', // padrão; o valor real vem de getLaunchConfig
};

// IMPORTANTE: os tokens da Pons são ERC-20 sem função burn() e sem mint().
// "Queimar" só é possível enviando para um endereço sem chave privada conhecida.
// Isso remove os tokens de circulação mas NÃO altera totalSupply() — qualquer
// cálculo honesto de market cap precisa subtrair os saldos queimados.
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
export const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- ABIs

export const FACTORY_ABI = [
  {
    type: 'event', name: 'TokenLaunched', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'deployer', type: 'address' },
      { indexed: true, name: 'dexFactory', type: 'address' },
      { indexed: false, name: 'pairToken', type: 'address' },
      { indexed: false, name: 'pool', type: 'address' },
      { indexed: false, name: 'dexId', type: 'uint256' },
      { indexed: false, name: 'launchConfigId', type: 'uint256' },
      { indexed: false, name: 'positionId', type: 'uint256' },
      { indexed: false, name: 'restrictionsEndBlock', type: 'uint256' },
      { indexed: false, name: 'initialBuyAmount', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'getLaunchedToken', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{
      name: '', type: 'tuple', components: [
        { name: 'token', type: 'address' },
        { name: 'deployer', type: 'address' },
        { name: 'pairedToken', type: 'address' },
        { name: 'positionManager', type: 'address' },
        { name: 'positionId', type: 'uint256' },
        { name: 'dexId', type: 'uint256' },
        { name: 'launchConfigId', type: 'uint256' },
        { name: 'restrictionsEndBlock', type: 'uint256' },
        { name: 'supply', type: 'uint256' },
        { name: 'isToken0', type: 'bool' },
        { name: 'poolFee', type: 'uint24' },
        { name: 'exists', type: 'bool' },
        { name: 'initialBuyAmount', type: 'uint256' },
      ],
    }],
  },
  {
    type: 'function', name: 'graduationStatus', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'pairedPrincipal', type: 'uint256' },
      { name: 'threshold', type: 'uint256' },
      { name: 'graduated', type: 'bool' },
    ],
  },
  {
    type: 'function', name: 'getDexConfig', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple', components: [
        { name: 'name', type: 'string' },
        { name: 'factory', type: 'address' },
        { name: 'positionManager', type: 'address' },
        { name: 'swapRouter', type: 'address' },
        { name: 'poolFee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'enabled', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function', name: 'getLaunchConfig', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple', components: [
        { name: 'pairToken', type: 'address' },
        { name: 'graduationThreshold', type: 'uint256' },
        { name: 'initialTick', type: 'int24' },
        { name: 'supply', type: 'uint256' },
        { name: 'maxWalletBps', type: 'uint16' },
        { name: 'maxTxBps', type: 'uint16' },
        { name: 'restrictionBlocks', type: 'uint32' },
        { name: 'reservedFee', type: 'uint24' },
        { name: 'enabled', type: 'bool' },
        { name: 'routerRequiresDeadline', type: 'bool' },
      ],
    }],
  },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
];

export const POOL_ABI = [
  {
    type: 'event', name: 'Swap', anonymous: false, inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'amount0', type: 'int256' },
      { indexed: false, name: 'amount1', type: 'int256' },
      { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
      { indexed: false, name: 'liquidity', type: 'uint128' },
      { indexed: false, name: 'tick', type: 'int24' },
    ],
  },
  {
    type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
  { type: 'function', name: 'tickSpacing', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'int24' }] },
];

export const TOKEN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'logo', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'liquidityPool', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Campos expostos diretamente pelo token da Pons (mais barato que ir na factory)
  { type: 'function', name: 'deployer', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'pairToken', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'poolFee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
  { type: 'function', name: 'launchBlock', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'maxTxAmount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'maxWalletAmount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'restrictionEndBlock', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'positionManager', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event', name: 'Transfer', anonymous: false, inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
];

export const abiItem = (abi, name, type = 'function') =>
  abi.find((i) => i.name === name && i.type === type) ?? (() => { throw new Error(`ABI: ${name} not found`); })();
