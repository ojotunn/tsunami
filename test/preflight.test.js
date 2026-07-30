// Preflight: validação da rota de compra contra os contratos, sem gastar nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// preflight contra uma RPC simulada: cobre o caminho feliz, a RPC sem state
// override, restrições ativas e um token que não é da factory.
import { preflight } from '../src/agent/preflight.js';
import { CONTRACTS } from '../src/chain/config.js';
const TOKEN='0x9f2b4c7e1a83d5064b7e2c9a15fd3e8b7c04a621';
const POOL='0x'+'cc'.repeat(20);
const Q96=2n**96n;

const mk=(o={})=>({
  chainId:async()=>o.chainId??4663,
  blockNumber:async()=>9_000_000n,
  read:async(addr,item)=>{
    if(item.name==='getLaunchedToken')return o.notLaunched?{exists:false}:{exists:true,isToken0:true,poolFee:10000n,dexId:0n,launchConfigId:0n,supply:10n**27n,restrictionsEndBlock:o.restrictionsEnd??0n,pairedToken:CONTRACTS.weth,positionManager:'0x'+'22'.repeat(20),positionId:1n};
    if(item.name==='getLaunchConfig')return {supply:10n**27n,maxWalletBps:2000,maxTxBps:1000,graduationThreshold:1n,routerRequiresDeadline:true,pairToken:CONTRACTS.weth,initialTick:0n,restrictionBlocks:0,reservedFee:0n,enabled:true};
    if(item.name==='getDexConfig')return {enabled:true,name:'uniswap-v3',swapRouter:'0x'+'77'.repeat(20),poolFee:10000n,tickSpacing:200n,factory:CONTRACTS.v3Factory,positionManager:'0x'+'22'.repeat(20)};
    if(item.name==='liquidityPool')return POOL;
    if(item.name==='slot0')return {sqrtPriceX96:Q96,tick:0n};
    if(item.name==='liquidity')return 10n**21n;
    if(item.name==='decimals')return 18n;
    if(item.name==='allowance')return 0n;
    return 0n;},
  call:async(m,p)=>{
    if(m==='eth_getCode')return '0x60006000';
    if(m==='eth_call'){
      if(p.length===3 && o.noOverride) throw new Error('invalid argument 2: too many arguments');
      if(o.revert) throw new Error('execution reverted: STF');
      return '0x';}
    throw new Error('unexpected '+m);},
});


test('preflight aprova o caminho feliz e simula ponta a ponta', async () => {
  const r = await preflight(mk(), TOKEN, '0.005');
  assert.ok(r.checks.every((c) => c.ok), 'algum check falhou');
  assert.equal(r.simulated, true);
  assert.equal(r.route.length, 4);
  assert.ok(r.checks.some((c) => /WITH deadline/.test(c.detail || '')));
  assert.ok(r.market.priceImpactPct);
});

test('RPC sem state override avisa em vez de fingir que simulou', async () => {
  const r = await preflight(mk({ noOverride: true }), TOKEN, '0.005');
  assert.equal(r.simulated, false);
  assert.ok(r.warnings.some((w) => /state overrides/.test(w)));
});

// A janela de restrição limita o tamanho da compra; não impede comprar. Ela é
// nota informativa, não reprovação — reprovar aqui foi o erro que fez o agente
// recusar ordens quatro ordens de grandeza abaixo do teto real.
test('janela anti-sniping vira nota informativa, não reprovação', async () => {
  const r = await preflight(mk({ restrictionsEnd: 9_999_999n }), TOKEN, '0.005');
  const check = r.checks.find((c) => c.name === 'anti-sniping window');
  assert.ok(check, 'o check da janela precisa existir');
  assert.equal(check.ok, true, 'janela ativa não reprova o preflight');
  assert.match(check.detail, /size-capped/);
  assert.ok(r.notes.some((n) => /capped at/.test(n)), 'a nota precisa dizer qual é o teto');
  assert.ok(!r.warnings.some((w) => /would revert/.test(w)));
});

test('token que não é desta factory para o preflight antes de montar rota', async () => {
  const r = await preflight(mk({ notLaunched: true }), TOKEN, '0.005');
  assert.ok(r.checks.some((c) => c.name === 'launched by this factory' && !c.ok));
  assert.equal(r.route, null);
});

test('chain errada aborta na primeira verificação', async () => {
  const r = await preflight(mk({ chainId: 1 }), TOKEN, '0.005');
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].ok, false);
});

test('revert na simulação é reportado, não engolido', async () => {
  const r = await preflight(mk({ revert: true }), TOKEN, '0.005');
  assert.ok(r.checks.some((c) => /^simulate/.test(c.name) && !c.ok));
});

test('compra grande demais para o pool vira aviso de impacto', async () => {
  const r = await preflight(mk(), TOKEN, '50');
  assert.ok(r.warnings.some((w) => /move the price/.test(w)));
});

test('collectFees permissionless habilita a delegação sem chave', async () => {
  const r = await preflight(mk(), TOKEN, '0.005');
  assert.equal(r.delegation, 'permissionless');
  assert.ok(r.checks.some((c) => c.name === 'collectFees callable by a third party' && c.ok));
});

test('collectFees restrito vira aviso explicando o que ainda funciona', async () => {
  const rpc = mk();
  const base = rpc.call;
  rpc.call = async (m, p) => {
    if (m === 'eth_call' && p[0]?.data?.startsWith('0xbc4b0a02') === false && p.length === 2 && p[0].to === '0x736D76699C26D0d966744cAe304C000d471f7F35') {
      throw new Error('execution reverted: NotAuthorized()');
    }
    return base(m, p);
  };
  const r = await preflight(rpc, TOKEN, '0.005');
  assert.equal(r.delegation, 'restricted');
  // A sonda usa um endereço sem relação com o token, então a recusa é esperada
  // e não é aviso: o agente, sendo o recipient do redirect, é autorizado.
  assert.ok(r.notes.some((n) => /qualifies\s+as the recipient/.test(n)));
});

test('sem fees a coletar ainda conta como permissionless', async () => {
  const rpc = mk();
  const base = rpc.call;
  rpc.call = async (m, p) => {
    if (m === 'eth_call' && p.length === 2 && p[0].to === '0x736D76699C26D0d966744cAe304C000d471f7F35') {
      throw new Error('execution reverted: NoFeesToCollect()');
    }
    return base(m, p);
  };
  assert.equal((await preflight(rpc, TOKEN, '0.005')).delegation, 'permissionless');
});
