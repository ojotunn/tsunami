// Cliente JSON-RPC com failover entre endpoints, retry com backoff e batching.
import { CHAIN } from '../chain/config.js';
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, topicOf } from './abi.js';
import { numberToHex } from './hex.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RpcClient {
  constructor({ urls = CHAIN.rpcUrls, timeoutMs = 15000, maxRetries = 4 } = {}) {
    if (!urls.length) throw new Error('no RPC endpoint configured');
    this.urls = urls;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.cursor = 0;
    this.id = 0;
  }

  async #post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const url = this.urls[this.cursor % this.urls.length];
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          // 429 é a RPC pública pedindo calma, não uma rede fora do ar. Trocar
          // de endpoint imediatamente só espalha o excesso; o certo é esperar o
          // tempo que ela mesma indica. Sem isso, um painel que faz várias
          // leituras seguidas se auto-derruba.
          const err = new Error(`HTTP ${res.status} em ${url}`);
          err.httpStatus = res.status;
          err.retryAfterMs = res.status === 429
            ? Math.min(Number(res.headers.get('retry-after') || 1) * 1000, 5000)
            : null;
          throw err;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (err.httpStatus === 429) {
          // Mesmo endpoint, espera dele: trocar de RPC não resolve excesso de
          // pedidos meus. Sem trocar o cursor, sem backoff exponencial.
          await sleep(err.retryAfterMs ?? 1000);
          continue;
        }
        this.cursor++;                                   // failover para a próxima RPC
        await sleep(Math.min(250 * 2 ** attempt, 4000));
      } finally {
        clearTimeout(t);
      }
    }
    const rateLimited = lastErr?.httpStatus === 429;
    throw Object.assign(
      new Error(rateLimited
        ? 'the public RPC is rate limiting this machine (HTTP 429) — wait a few seconds and try again'
        : `RPC failed after ${this.maxRetries + 1} attempts: ${lastErr?.message}`),
      { httpStatus: lastErr?.httpStatus, transport: true },
    );
  }

  async call(method, params = []) {
    const out = await this.#post({ jsonrpc: '2.0', id: ++this.id, method, params });
    if (out.error) {
      // O payload de revert vive em error.data e é a única coisa que diz por que
      // a transação falharia. Perder isso na string do erro custa caro: o usuário
      // vê "execution reverted" e ninguém sabe qual exigência do contrato quebrou.
      throw Object.assign(new Error(`${method}: ${out.error.message} (${out.error.code})`), {
        rpcCode: out.error.code,
        rpcData: typeof out.error.data === 'string' ? out.error.data : out.error.data?.data,
      });
    }
    return out.result;
  }

  /** Envia várias chamadas num único round-trip. */
  async batch(calls) {
    if (!calls.length) return [];
    const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++this.id, method: c.method, params: c.params || [] }));
    const out = await this.#post(body);
    const byId = new Map(out.map((r) => [r.id, r]));
    return body.map((b) => {
      const r = byId.get(b.id);
      if (!r) throw new Error('missing response in batch');
      if (r.error) throw new Error(`${b.method}: ${r.error.message}`);
      return r.result;
    });
  }

  // ------------------------------------------------------------ helpers

  chainId = async () => Number(BigInt(await this.call('eth_chainId')));
  blockNumber = async () => BigInt(await this.call('eth_blockNumber'));
  getBalance = async (address, block = 'latest') => BigInt(await this.call('eth_getBalance', [address, block]));
  getBlock = async (block = 'latest') =>
    this.call('eth_getBlockByNumber', [typeof block === 'bigint' ? numberToHex(block) : block, false]);
  gasPrice = async () => BigInt(await this.call('eth_gasPrice'));

  /** Chamada view tipada a partir de um item da ABI. */
  async read(address, abiItemDef, args = [], block = 'latest') {
    const data = encodeFunctionData(abiItemDef, args);
    const raw = await this.call('eth_call', [{ to: address, data }, block]);
    return decodeFunctionResult(abiItemDef, raw);
  }

  /** Várias leituras view num único batch. Retorna { ok, value|error } por item. */
  async readMany(reads, block = 'latest') {
    const results = await this.batch(reads.map((r) => ({
      method: 'eth_call',
      params: [{ to: r.address, data: encodeFunctionData(r.item, r.args || []) }, block],
    }))).catch(async () => {
      // Alguma RPC não aceita batch — cai para sequencial.
      const out = [];
      for (const r of reads) {
        try { out.push(await this.call('eth_call', [{ to: r.address, data: encodeFunctionData(r.item, r.args || []) }, block])); }
        catch { out.push(null); }
      }
      return out;
    });
    return results.map((raw, i) => {
      if (raw == null || raw === '0x') return { ok: false, error: 'retorno vazio' };
      try { return { ok: true, value: decodeFunctionResult(reads[i].item, raw) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
  }

  /** getLogs com decodificação automática do evento. */
  async getLogs({ address, event, fromBlock, toBlock, topics }) {
    const params = {
      fromBlock: typeof fromBlock === 'bigint' ? numberToHex(fromBlock) : fromBlock,
      toBlock: typeof toBlock === 'bigint' ? numberToHex(toBlock) : toBlock,
      topics: topics || (event ? [topicOf(event)] : undefined),
    };
    if (address) params.address = address;
    const logs = await this.call('eth_getLogs', [params]);
    return logs.map((log) => ({
      ...log,
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(BigInt(log.logIndex)),
      args: event ? decodeEventLog(event, log) : undefined,
    }));
  }
}
