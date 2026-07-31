# Blizzard Agents — arquitetura

Ferramenta de market making controlada por agentes de IA para tokens lançados na
[pons](https://www.ponsfamily.com/), sobre a Robinhood Chain.

---

## 1. Premissas verificadas do protocolo

Tudo abaixo foi lido da documentação oficial e da ABI verificada da factory — não é suposição.

| Item | Valor |
|---|---|
| Rede | Robinhood Chain, chain ID **4663**, gas em ETH |
| RPC pública | `https://rpc.mainnet.chain.robinhood.com` |
| Factory ativa | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (a partir do bloco 8991118) |
| Locker | `0x736D76699C26D0d966744cAe304C000d471f7F35` |
| V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Supply | fixo, 1.000.000.000 por token |
| Mercado | pool **Uniswap V3** contra WETH, fee tier **1%** (10000) |
| Bonding curve | **não existe** — o pool nasce vivo e continua o mesmo após a graduação |
| Taxa de lançamento | 0,0005 ETH |
| Split de fees | 70% criador / 30% protocolo |

Da ABI verificada do **Locker** saem três funções que mudam o desenho do produto:

| Função | Efeito |
|---|---|
| `collectFees(token)` | libera as creator rewards acumuladas na posição travada |
| `setFeeRedirect(token, novaCarteira)` | aponta o payout do criador para outro endereço |
| `setFeeCollector(addr, bool)` | autoriza um terceiro a disparar a coleta |
| `feeRecipientTokens(addr, i)` | enumera todos os tokens cujo payout vai para um endereço |

E da ABI do **token** sai o achado mais importante para quem quer queimar supply:

> O token da pons é um ERC-20 **sem `burn()` e sem `mint()`**. Não existe função que
> reduza `totalSupply()`. "Queimar" só é possível enviando para um endereço sem chave
> conhecida (`0x…dEaD`): as moedas saem de circulação, mas `totalSupply()` continua
> 1.000.000.000 para sempre. Exploradores e sites que calculam market cap por total
> supply **não vão refletir a queima**. A ferramenta calcula e mostra o supply em
> circulação (`total − saldo queimado`) separadamente, e o painel avisa isso em destaque.

Três consequências de projeto saem direto daí:

1. **Não há fase de curva.** Todo token já é um pool V3 desde o bloco zero. A ferramenta
   é, na prática, um gestor de posição e de ordens em Uniswap V3 — não um bot de launchpad.
2. **A taxa de 1% é alta.** Ela domina a economia de qualquer estratégia de alta frequência:
   ida e volta custa ~2% antes de qualquer spread. Estratégias viáveis são as de horizonte
   mais longo (provisão de liquidez em faixa, rebalanceamento de inventário), não scalping.
3. **A factory expõe limites anti-sniping** (`maxTxBps`, `maxWalletBps`, `restrictionsEndBlock`).
   Uma ordem que os viola reverte e queima gás. O agente lê esses limites **antes** de montar
   qualquer ordem — é o módulo `agent/guards.js`.

## 2. Escopo

**O que a ferramenta faz:** provisão e gestão de liquidez, rebalanceamento de inventário,
cotação com controle de impacto, indexação e análise de risco de tokens, execução com
limites duros de capital e drawdown.

**O que ela não faz:** volume artificial entre carteiras controladas pelo mesmo dono
(wash trading), ordens desenhadas para mover preço sem intenção econômica, ou simulação de
demanda. Além de ilegal na maioria das jurisdições, isso é economicamente destrutivo para
quem paga: a taxa de 1% por perna significa que cada ciclo de wash queima 2% do capital
para produzir um número que não sustenta preço. O `evaluate()` da política existe justamente
para tornar esse tipo de padrão detectável e barrável no log de auditoria.

## 3. Camadas

```
┌───────────────────────────────────────────────────────────────┐
│  Site                web/pages/{landing,app}.html             │
│  API + sessões       web/{server,auth}.js  login por carteira │
│  CLI                 cli.js                                   │
├───────────────────────────────────────────────────────────────┤
│  Funções do agente   functions/                               │
│    buybackBurn · rewards · dca · dipBuy · airdrop             │
│  Motor               agent/runner.js   monta ctx e roda tudo  │
├───────────────────────────────────────────────────────────────┤
│  Política de risco   agent/policy.js   ← veto obrigatório     │
│  Guards do protocolo agent/guards.js   ← maxTx / maxWallet    │
├───────────────────────────────────────────────────────────────┤
│  Execução            agent/executor.js  compila, simula, envia │
│  Transações          chain/{tx,rlp,router}.js  EIP-1559        │
│  Carteira            wallet/{account,keystore,agentWallet}.js │
├───────────────────────────────────────────────────────────────┤
│  Locker              chain/locker.js   rewards e delegação    │
│  Mercado             market/pricing.js preço, impacto, depth  │
│  Indexador           indexer/{run,db}.js  eventos → SQLite    │
├───────────────────────────────────────────────────────────────┤
│  Cripto              core/secp256k1.js  assinar / ecrecover   │
│  Núcleo              core/{keccak,abi,rpc,hex}.js             │
└───────────────────────────────────────────────────────────────┘
```

**Zero dependências externas.** keccak256, codec ABI, cliente JSON-RPC, derivação de conta
secp256k1 (incluindo aritmética de curva, RFC 6979, assinatura e `ecrecover`) e keystore V3
são implementados sobre `node:crypto` e `node:sqlite`. Isso não é purismo: um processo que
guarda chaves privadas e assina transações não deveria carregar uma árvore de centenas de
pacotes transitivos que qualquer um pode comprometer via npm.

A curva não é aceita na base da confiança: a suíte cruza as duas direções contra o
verificador ECDSA do `node:crypto` — assinaturas geradas aqui precisam ser aceitas por ele,
e assinaturas dele precisam ser aceitas aqui — além de conferir múltiplos de G contra os
valores públicos da secp256k1 e o determinismo do RFC 6979.

## 4. Custódia híbrida

O site opera em dois modos combinados, e a diferença entre eles é quem guarda o quê.

**Delegação sem chave — o padrão.** O criador assina **uma única transação** na carteira
dele: `setFeeRedirect(token, endereçoDoAgente)`. A partir daí as creator rewards caem
direto na carteira do agente, sem que o servidor jamais veja a chave privada do usuário.
Nenhuma outra permissão é concedida — o redirect move o payout, não dá acesso à carteira.
Para desligar, o criador assina de novo apontando para onde quiser.

**Carteira hospedada — só para capital de operação.** O agente gera uma conta EVM nova e
exclusiva, o usuário deposita ali o valor destinado a buyback/DCA, e é só esse saldo que
está em risco. Serve para as funções que precisam gastar ETH.

Por que essa separação importa: no modelo em que o usuário cola a chave privada, um
vazamento drena a carteira principal — todos os tokens, todos os NFTs, tudo. No modelo
híbrido, o pior caso é perder o depósito operacional, e as rewards continuam sendo
redirecionáveis pelo criador a qualquer momento. É a diferença entre um incidente e uma
ruína. **Por isso a ferramenta não implementa import de chave privada.**

O ciclo da carteira hospedada:

```
criar agente
   └─> gera par de chaves secp256k1 novo e exclusivo (CSPRNG do SO)
   └─> deriva endereço EVM (keccak256 da chave pública, EIP-55)
   └─> cifra a chave em keystore Web3 V3 (scrypt N=262144 + AES-128-CTR + MAC keccak)
   └─> grava em ./data/keystores/<id>.json com permissão 0600
   └─> descarta a chave em claro da memória do processo
   └─> status: awaiting_funding

usuário envia ETH da Robinhood Chain para o endereço do agente
   └─> await-funding faz polling de eth_getBalance até o mínimo da política
   └─> status: funded

o agente só movimenta o que está naquele endereço
   └─> teto por operação, teto diário, reserva de gás intocável
   └─> exportar keystore devolve o controle total ao usuário a qualquer momento
```

Propriedades que isso garante:

- **Isolamento de perda.** O capital em risco é exatamente o depósito. A carteira principal
  do usuário nunca assina nada, nunca dá `approve`, nunca é exposta.
- **Recuperabilidade.** O keystore é o formato padrão do geth/MetaMask. Importar o JSON com a
  senha devolve os fundos, mesmo que a ferramenta desapareça.
- **A senha é o único segredo.** Não há custódia, não há backup em servidor. Perdeu a senha,
  perdeu os fundos daquele agente — por isso o CLI avisa na criação.

Um agente por estratégia, ou por token, é o padrão recomendado: separa contabilidade,
separa risco, e um kill switch derruba um sem tocar nos outros.

## 5. Fluxo de decisão

```
  observação (indexador)
        ↓
  agente de IA propõe:  { kind, token, side, notionalWei, priceImpactBps, rationale }
        ↓
  guards.js       ── viola limite do protocolo? → rejeita (economiza gás)
        ↓
  policy.evaluate ── viola limite de risco?     → rejeita
        ↓
  recordDecision  ── grava proposta + veredito na tabela `decisions` (auditoria)
        ↓
  modo 'propose' → aguarda aprovação humana
  modo 'auto'    → executa se abaixo de requireApprovalAboveWei
```

O agente de IA **nunca** chama a camada de execução diretamente. Ele produz um objeto de
decisão; quem executa é o motor determinístico, depois de dois filtros. Toda proposta fica
registrada — inclusive as rejeitadas, que são o sinal mais útil para calibrar a política.

Limites da política padrão (`agent/policy.js`, todos ajustáveis):

| Limite | Padrão | Por quê |
|---|---|---|
| `maxNotionalPerTradeWei` | 0,01 ETH | teto de erro único |
| `maxDailyNotionalWei` | 0,1 ETH | teto de erro composto |
| `reserveGasWei` | 0,002 ETH | agente sem gás não consegue sair da posição |
| `maxDrawdownBps` | 2000 (20%) | pausa automática |
| `maxInventoryBps` | 6000 (60%) | evita virar holder involuntário |
| `maxTradesPerHour` | 6 | a fee de 1% pune frequência |
| `mode` | `propose` | autonomia é opt-in explícito |

## 6. Estratégias viáveis neste mercado

Dado pool V3 único, fee de 1% e supply fixo:

- **Faixa de liquidez concentrada.** Manter a posição LP numa faixa em torno do preço, com
  rebalanceamento quando o preço sai. Receita = fees de 1%; risco = perda impermanente, que
  em token de supply fixo e alta volatilidade é substancial. Rentável apenas com volume real.
- **Inventário alvo.** Manter uma proporção fixa (ex.: 50/50 em valor) entre token e WETH,
  comprando na queda e vendendo na alta dentro de bandas. É market making passivo de verdade.
- **Cotação com teto de impacto.** Nunca enviar ordem que mova o preço acima de N bps;
  fatiar ordens grandes ao longo do tempo. É o que `simulateSwap` calcula antes de assinar.
- **Filtro de risco de token.** Antes de alocar em qualquer token: liquidez mínima,
  concentração de holders, restrições ainda ativas, distância da graduação. A IA é útil
  aqui — classificação qualitativa a partir de metadados on-chain e sociais.

O que **não** funciona: qualquer coisa que dependa de girar posição rápido. 2% de round trip
exige convicção direcional, e aí não é mais market making.

## 7. Segurança

- Chave privada nunca em disco em claro, nunca em variável de ambiente, nunca em log.
- `unlockAgent()` devolve a chave só pelo tempo da operação; o retorno não é persistido.
- Keystore com permissão 0600; `scrypt` com parâmetros do geth (~2s por desbloqueio, proposital).
- Zero dependências de terceiros no caminho da chave.
- Toda decisão auditável na tabela `decisions`, incluindo o veredito da política.
- Kill switch por agente na política; efeito imediato na próxima avaliação.
- Recomendação operacional: RPC própria (Alchemy/QuickNode têm Robinhood Chain) em vez da
  pública, para não depender de rate limit alheio na hora de sair de uma posição.

## 8. Funções disponíveis no painel

O usuário liga só o que quer. Cada função tem parâmetros próprios e passa pelos mesmos
dois filtros (guards do protocolo + política de risco) antes de virar uma proposta.

| Função | Precisa de | O que faz |
|---|---|---|
| **Buyback & burn** | capital | compra o token com o saldo do agente e envia para `0x…dEaD` |
| **Creator rewards → buyback & burn** | delegação | coleta as rewards, reserva até a graduação e aplica 100% em compra e queima |
| **Compras programadas (DCA)** | capital | compra um valor fixo em intervalo definido pelo usuário, com orçamento total e teto de impacto |
| **Compra em quedas** | capital | compra em degraus conforme o preço cai em relação à máxima da janela |
| **Airdrop** | lista | distribui o token para destinatários informados, em lotes, com validação prévia |

Detalhes que valem registrar:

- **Boost de rewards.** O modo `reserve_until_graduation` acumula sem comprar nada até
  `graduationStatus().graduated` virar `true`. Só então aplica o percentual configurado
  em buyback e queima. Antes da graduação o pool é raso e comprar ali é caro.
- **DCA e o custo da taxa.** O painel calcula e mostra quanto a cadência escolhida custa
  só em taxa de pool. A 1% por compra, 24 compras/dia entregam ~24% do capital ao ano ao
  pool. Isso não é um detalhe: é frequentemente maior que o efeito pretendido.
- **Compra em quedas** usa a **máxima da janela** como referência, não o último preço —
  senão qualquer oscilação dispara. A escada evita gastar tudo no primeiro degrau de uma
  queda que continua.
- **Airdrop** exige lista externa. O módulo valida endereços, recusa duplicatas, checa o
  `maxWallet` do protocolo por destinatário e **cancela o lote se algum destinatário for
  uma carteira da própria ferramenta**.

## 9. Uma função que não foi construída

O pedido original incluía: *criar várias carteiras e distribuir tokens para aumentar o
número de holders, e essas carteiras nunca vendem*. Isso não está implementado, e o
módulo de airdrop bloqueia ativamente a tentativa.

A razão é direta. Contagem de holders é um número que terceiros usam para julgar se a
distribuição de um token é saudável antes de comprar. Carteiras que o próprio dono
controla não são holders — o saldo não mudou de dono, mudou de bolso. Inflar esse
contador transmite ao mercado uma informação falsa sobre uma coisa específica que o
mercado está tentando medir. Na prática também é frágil: carteiras financiadas pela mesma
origem e que nunca vendem formam um padrão que qualquer analista on-chain identifica em
minutos, e o estrago reputacional quando isso aparece é maior que o ganho.

O caminho que funciona para o mesmo objetivo é distribuição real — airdrop verificável
para pessoas que existem, recompensa por ação verificável on-chain, e um painel público
de distribuição honesto. O primeiro já está implementado.

## 10. Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| 0 | Núcleo (keccak, ABI, RPC), config verificada | **pronto** |
| 1 | Indexador de lançamentos e swaps, preço, profundidade | **pronto** |
| 2 | Carteira do agente, keystore, funding, política, guards | **pronto** |
| 3 | Módulo do Locker + diagnóstico de delegação sem chave | **pronto** |
| 4 | As 5 funções do painel + motor que as roda | **pronto** |
| 5 | Painel web (API REST + interface) | **pronto** |
| 6 | Curva secp256k1 própria: assinar, ecrecover, verificar | **pronto** |
| 7 | Site: landing, login por carteira, isolamento por conta | **pronto** |
| 8 | RLP, assinatura EIP-1559, motor de execução, testnet | **pronto** |
| 9 | Gestão de posição LP via `positionManager` | a fazer |
| 10 | Camada de agente de IA (proposta estruturada + relatório) | a fazer |

A fase 8 é a que move dinheiro, e está pronta. Ela precisa de: assinatura ECDSA com recovery id
— já implementada em `core/secp256k1.js` na fase 6, então a dependência externa deixou de
ser necessária —, codificação RLP da transação tipo 2, gestão de nonce, e simulação `eth_call` obrigatória
antes de todo `eth_sendRawTransaction`. Recomendação: fazer a fase 8 inteira contra a
testnet da Robinhood Chain antes de qualquer ETH real.

## 11. O que falta antes de isso virar um site público

O site já é multiusuário e autenticado, mas escuta em `127.0.0.1`. Transformar em produto exige,
em ordem de importância:

1. ~~Autenticação e isolamento por conta.~~ **Feito na fase 7:** login por assinatura de
   carteira (nonce de uso único, sessão em cookie `HttpOnly; SameSite=Strict`) e cada
   agente pertence a uma conta, com leitura, escrita e export de keystore barrados para
   terceiros.
2. **Decisão sobre custódia em escala.** Guardar N carteiras quentes de N usuários é
   atividade de custodiante. Além do risco técnico (um servidor comprometido drena todo
   mundo de uma vez), há exposição regulatória real dependendo da jurisdição. O modo de
   delegação sem chave reduz muito isso — quanto mais funções puderem viver só nele, melhor.
3. **HTTPS, rate limit e CSRF.** Básico, mas o painel move dinheiro.
4. **Keystores fora do disco da aplicação.** KMS, HSM ou no mínimo volume cifrado com
   chave que não vive no mesmo servidor.
5. **RPC própria.** A pública tem rate limit; depender dela na hora de sair de uma posição
   é um risco operacional concreto.
6. **Termos de uso e divulgação.** Se o token faz buyback programático, dizer isso
   publicamente é o que separa uma tesouraria transparente de uma suspeita de manipulação.

## 12. Riscos que a ferramenta não elimina

- **Perda impermanente** em pool de token volátil com supply fixo — é a maior fonte de perda
  para um LP, e nenhum limite de política a evita, só a reduz.
- **Liquidez que some.** O criador detém 70% das fees e, dependendo do lock, pode ter saída.
  Ler o Locker antes de alocar é obrigatório.
- **Reorgs e RPC pública.** O indexador usa 2 confirmações; ajuste conforme o comportamento
  da chain.
- **Risco regulatório.** Prover liquidez de forma sistemática em tokens pode ser atividade
  regulada dependendo da sua jurisdição e do volume. Isso é uma consideração jurídica real,
  não um detalhe — vale conversar com um advogado antes de escalar. Nada aqui é
  recomendação financeira.
