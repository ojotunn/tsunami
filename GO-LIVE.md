# Go-live checklist

Everything below is either done for you or a decision only you can make. Work top to
bottom; the order matters.

---

## 1 — Before anyone else touches it

- [ ] **Generate a master key** and keep it off the server.
      ```
      node src/cli.js master-key
      ```
      Set it as `PONS_MASTER_KEY` in your host's secrets (`fly secrets set`, not a file on
      the volume). Without it, keystores are protected only by each user's password, and
      anyone who copies the data volume walks away with the files. The server prints a
      warning at startup while it is missing.

      **If you lose this key, every agent sealed with it becomes unrecoverable.** Store it
      the way you would store a seed phrase.

- [ ] **Confirm the testnet contract addresses.** Send the draft in `EMAIL-PONS.txt`.
      Until pons answers, you cannot exercise the signing path without real money.

- [ ] **Run the preflight** on a real token and read the `creator rewards` block. It tells
      you whether `collectFees` is permissionless — which decides whether keyless
      delegation works end to end, or whether the creator has to trigger collection.
      ```
      node src/cli.js preflight 0x<token>
      ```

## 2 — Prove the signing path on testnet

- [ ] Point at testnet with the addresses pons gives you:
      ```
      PONS_NETWORK=testnet
      PONS_FACTORY=0x…  PONS_LOCKER=0x…  PONS_WETH=0x…  PONS_V3_FACTORY=0x…
      ```
- [ ] Create an agent, fund it with a small amount of testnet ETH.
- [ ] Run one full buyback with `PONS_ALLOW_LIVE_EXECUTION=1` and `--live`.
      Confirm all four transactions land: wrap, approve, swap, burn transfer.
- [ ] Check the burn transfer amount equals what the swap returned — not the whole balance.

Do not skip this. It is the only step that proves the transactions this tool builds are
accepted by the real contracts.

## 3 — Hosting

- [ ] Pick one (details in `DEPLOY.md`): Fly.io (~US$4/month, needs a card) or a VPS
      (~€4/month, you keep the disk).
- [ ] Set every secret: `PONS_MASTER_KEY`, `PONS_RPC_URL`, `PONS_DOMAIN`.
- [ ] `PONS_SECURE_COOKIES=1` — required once you have HTTPS.
- [ ] `PONS_TRUST_PROXY=1` — **only** if a proxy you control is in front. Turning it on
      without one lets anyone spoof their IP and skip the rate limits.
- [ ] Leave `PONS_ALLOW_LIVE_EXECUTION` **off** until step 2 passed on mainnet-like conditions.
- [ ] Use your own RPC. The public one is rate limited, and being throttled while trying to
      exit a position is a real operational risk.

## 4 — Backups

- [ ] Set up a routine copy of the keystore directory:
      ```
      node src/cli.js backup C:\backups\pons
      ```
      or, on the server, `tar czf` the volume path (see `DEPLOY.md`).
- [ ] Store the archive somewhere other than the server.
- [ ] **Test a restore once**, before you have anything to lose. A backup you have never
      restored is a guess.

The database can be rebuilt by re-indexing the chain. The keystores cannot be rebuilt at
all — that directory is the only irreplaceable thing here.

## 5 — What you owe your users

- [ ] The terms page at `/terms` is live and linked. Agent creation is blocked until the
      user accepts it. Read it yourself and make sure you agree with what it says on your
      behalf — particularly the custody paragraph.
- [ ] Decide, and be able to answer: **are you a custodian?** Holding many users'
      encrypted keystores while their agents hold funds looks a lot like custody, and the
      answer depends on your jurisdiction and volume. Talk to a lawyer before you scale.
      The more functions that stay on keyless delegation, the less of this you take on.
- [ ] If your own token runs programmatic buybacks, disclose it publicly.

## 6 — Launch switches

The site ships with the dangerous part switched off. That is deliberate: your friends can
use everything except the step that spends money, so the worst case on day one is a wasted
afternoon rather than someone's ETH.

- [ ] Launch with `PONS_ALLOW_LIVE_EXECUTION` **unset**. Agents get created, rewards get
      delegated, decisions get proposed and analysed — nothing reaches the chain.
- [ ] Set `PONS_ADMIN_ADDRESS` to your own wallet. Without it you cannot pause the service
      from the app, and the server warns you about that at startup.
- [ ] Know how to stop without killing the process:
      ```
      node src/cli.js pause "checking the swap route"
      node src/cli.js resume
      node src/cli.js status
      ```
      Pausing blocks agent creation and execution. Reading agents and exporting keystores
      stay open on purpose — nobody should ever be locked out of their own funds because
      you are debugging.
- [ ] Only after you have personally run one small buyback end to end, turn on
      `PONS_ALLOW_LIVE_EXECUTION=1`. The early-access banner adjusts its wording
      automatically once it is on.

## 7 — Operating

- [ ] Watch `/healthz` from an uptime monitor.
- [ ] Check `node src/cli.js status` after any incident: failed executions keep the error
      and the transactions that already confirmed, so you can tell a user exactly where
      their money stopped.
- [ ] Read the `decisions` table periodically. Blocked decisions are the useful signal:
      they tell you which policy limits are actually binding.
- [ ] Keep `mode: 'propose'` as the default policy. Autonomy should be a choice each user
      makes deliberately, not the state they land in.

---

## What is still not built

- **LP position management** (minting and rebalancing ranges via `positionManager`).
- **The AI agent layer** — today the functions are deterministic rules. The proposal
  format and the audit trail are already designed for a model to write into.

Neither blocks going live. Both are the natural next phase.
