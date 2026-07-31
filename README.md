# Blizzard Agents

Agent-driven market making tools for tokens launched on [pons](https://www.ponsfamily.com/)
(Robinhood Chain, chain ID 4663).

**Zero npm dependencies.** Node >= 22.5 and nothing else.

- [ARQUITETURA.md](./ARQUITETURA.md) — full design document (in Portuguese)
- [DEPLOY.md](./DEPLOY.md) — putting it online
- [GO-LIVE.md](./GO-LIVE.md) — checklist before real users touch it

## Run it

```bash
node --version     # must be >= 22.5 (uses node:sqlite)
npm test           # 154 tests, all offline
npm run web        # http://127.0.0.1:8787
```

Three pages:

| Path | What it is |
|---|---|
| `/` | Public landing page |
| `/app` | The app — wallet login, agents, functions |
| `/demo` | Interactive demo with a simulated wallet and chain (`npm run build:demo`) |
| `/terms` | Terms and risks — accepting is required before creating an agent |

## Functions

| Function | Needs | What it does |
|---|---|---|
| Buyback & burn | capital | Buys the token and sends it to the burn address |
| Creator rewards → buyback & burn | delegation | Collects rewards, reserves until graduation, then puts 100% into buy and burn |
| Scheduled buys (DCA) | capital | Fixed amount on your interval, with a total budget and impact ceiling |
| Dip buying | capital | Ladder steps against the window high, with a cooldown |
| Airdrop | a list | Batched distribution to recipients you provide, validated first |
| Reward the holders | a token balance | Distributes to the real holders read from chain, equal or proportional |

> **About burning:** the pons token has no `burn()` function. Sending to `0x…dEaD`
> removes coins from circulation, but `totalSupply()` stays at 1B forever. The app
> reports circulating supply separately so you publish a number that holds up.

## Sign-in

There is no password and no signup. Users prove control of an address by signing a
plain-text message (`personal_sign`) carrying a single-use nonce; the server recovers
the address from the signature. Public-key recovery (`ecrecover`) is implemented here
and cross-validated against `node:crypto`'s ECDSA verifier in the test suite.

Every agent belongs to one account. Reading, configuring, running, and exporting a
keystore are all blocked for anyone else — see `test/web.test.js`.

## Custody

Deliberately split, so each kind of access has the smallest blast radius:

- **Keyless delegation (default).** The creator signs one `setFeeRedirect(token, agent)`
  transaction. Rewards then land in the agent wallet and the server never sees their
  private key. Reversible at any time by signing again.
- **Hosted wallet (capital only).** A fresh EVM account per agent, key encrypted in a
  Web3 V3 keystore (scrypt + AES-128-CTR + keccak MAC), file mode 0600. Only the
  deposit is ever at risk.

There is no field to paste a private key, on purpose: in that model a leak costs the
whole wallet instead of the operating deposit.

## CLI

```bash
node src/cli.js doctor                    # check RPC, chain id, factory
node src/cli.js agent create --label mm   # create an agent + wallet
node src/cli.js index backfill --blocks 5000
node src/cli.js token 0x…                 # state, price, liquidity, limits
node src/cli.js quote 0x… --in 0.01       # simulate an order and its impact
node src/cli.js preflight 0x…             # check the whole buy route on chain
node src/cli.js decisions <agentId>       # list recorded decisions
node src/cli.js execute <decisionId>      # dry run: simulate + estimate gas
node src/cli.js execute <decisionId> --live   # actually send
node src/cli.js master-key                # generate a server master key
node src/cli.js backup <folder>           # copy the keystores somewhere safe
node src/cli.js status                    # operator view
node src/cli.js pause "reason" / resume   # stop new agents and executions
```

## Environment

| Variable | Default | Use |
|---|---|---|
| `PONS_RPC_URL` | public RPC | Your own endpoint; takes priority |
| `PONS_DB` | `./data/pons.sqlite` | Local database |
| `PONS_KEYSTORE_DIR` | `./data/keystores` | Agent keystores |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Where the site listens |
| `PONS_DOMAIN` | `Blizzard Agents` | Name shown in the sign-in message |
| `PONS_SECURE_COOKIES` | off | `1` sets `Secure` on the session cookie and enables HSTS |
| `PONS_TRUST_PROXY` | off | `1` reads `X-Forwarded-For` for rate limiting — only behind your own proxy |
| `PONS_PASSWORD` | — | Keystore password for non-interactive CLI use; avoid in production |
| `PONS_NETWORK` | `mainnet` | `testnet` switches chain id, RPC and explorer together |
| `PONS_ALLOW_LIVE_EXECUTION` | off | `1` allows transactions to actually be sent. Without it every execution is a dry run |
| `PONS_FACTORY` / `PONS_LOCKER` / `PONS_WETH` | mainnet values | Override contract addresses (needed on testnet) |
| `PONS_ADMIN_ADDRESS` | — | Your wallet; the only account that can pause the service and see operator status |
| `PONS_MAINTENANCE` | off | `1` starts the server paused (creating and executing blocked) |
| `PONS_MASTER_KEY` | — | Seals keystores at rest so a stolen volume is not enough. Generate with `node src/cli.js master-key` and keep it off the server |
| `PONS_FEE_ADDRESS` | — | Wallet that receives the service fee. **Unset means no fee at all** |
| `PONS_FEE_BPS` | `500` | Service fee in basis points (500 = 5%). Ceiling: 1000 (10%) |

### Service fee

If you run a hosted instance you can charge for it. Set `PONS_FEE_ADDRESS` to the
wallet that collects, and the agent pays that share **in ETH** on each buy
(`buyback_burn`, `dca`, `dip_buy`) and on each creator-rewards collection.

What is never charged: airdrops, which only move tokens the user already owns;
the buyback that redeploys collected rewards, which already paid on collection;
and withdrawals, so nobody is ever locked out of their own money by a fee.

The fee is a normal step in the decision, so it shows up in the audit payload, in
`preflight`, and on screen before the user approves anything. It is also the last
step and a failure there does not fail the decision — if it cannot be paid, the
operator loses the fee, not the user's trade. Misconfiguration (bad address, bps
above the ceiling) switches the fee **off** and logs an error; it never stops the
server. Introducing a fee bumps `TERMS_VERSION`, which forces every account to
read and accept the terms again before its next live execution.

## Status

Phases 0–8 done and tested (154 offline tests): core (keccak, ABI codec, JSON-RPC),
indexer, pricing and depth, agent wallet, risk policy, protocol guards, Locker module
with keyless delegation, the five functions, own secp256k1 curve (sign / ecrecover),
wallet authentication with per-account isolation, the site, and the execution layer
(RLP, EIP-1559 signing, mandatory simulation, gas ceiling, nonce management).

**Execution is implemented but locked off by default.** The agent compiles a decision
into concrete transactions, simulates every one with `eth_call`, estimates gas and refuses
to sign for the wrong chain — but it only *sends* when the server runs with
`PONS_ALLOW_LIVE_EXECUTION=1` and the request explicitly asks for it. Everything else is a
dry run. Test on the testnet (`PONS_NETWORK=testnet`, chain 46630) before touching mainnet.

Not implemented as a design decision: creating wallets to inflate holder count, and
importing a user's private key. Reasons are in sections 9 and 4 of ARQUITETURA.md.

## Security notes

- Agent private keys are generated locally and encrypted in a Web3 V3 keystore. They
  never touch disk in the clear.
- Without the password, an agent's funds are unrecoverable. Keep it off the server.
- `agent export <id>` returns the keystore for import into MetaMask.
- Rate limiting: 20/min on auth, 5/hour on agent creation, 240/min otherwise, per IP.
- Security headers: CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS when configured.
- The server binds `127.0.0.1` by default. Read DEPLOY.md before exposing it.

None of this is financial advice. Fixed-supply tokens in a single pool are highly
volatile, and impermanent loss can exceed the fees an LP earns.

Source comments and the architecture document are in Portuguese; everything
user-facing is en-US.
