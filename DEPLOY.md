# Deploying Tsunami

The app is a single Node process with no npm dependencies. It needs two things a
typical serverless host cannot give you: **a process that keeps running**, and **a
disk that survives restarts** (SQLite database + agent keystores). That rules out
Vercel and Netlify. Everything below works.

Nothing here moves money yet — the execution layer is not implemented, so a first
deploy is genuinely low risk. Read [§ Before real funds](#before-real-funds) before
that changes.

---

## Recommended: Fly.io

Cheapest path to HTTPS + a persistent volume, and you get a free `*.fly.dev`
hostname while you don't have a domain.

```bash
# once
curl -L https://fly.io/install.sh | sh
fly auth signup           # or: fly auth login

# in the project folder
fly launch --no-deploy --copy-config      # keeps the fly.toml in this repo
fly volumes create pons_data --size 1     # 1 GB is plenty to start
fly deploy
```

Your site is at `https://<app-name>.fly.dev`. Then:

```bash
# point the login message at the real hostname
fly secrets set PONS_DOMAIN=<app-name>.fly.dev

# strongly recommended: your own RPC instead of the public one
fly secrets set PONS_RPC_URL=https://...
```

When you buy a domain:

```bash
fly certs add app.yourdomain.com     # then add the DNS records it prints
fly secrets set PONS_DOMAIN=app.yourdomain.com
```

**Do not enable `auto_stop_machines`.** Sessions and the indexer cursor live in the
process; a machine that sleeps loses in-flight work and rate-limit state.

---

## Alternative: your own VPS

More control and cheaper at scale. Any 1 GB box works (Hetzner CX22, DigitalOcean,
Contabo). You keep the disk holding the keystores — nobody else's volume snapshot
contains them.

```bash
# on the server, with Docker installed
git clone <your repo> Tsunami && cd Tsunami

# 1. point your domain's A record at this machine's IP
# 2. edit Caddyfile: replace Tsunami.example.com and the email
# 3. set the same domain here
echo "PONS_DOMAIN=app.yourdomain.com" > .env
echo "PONS_RPC_URL=https://..." >> .env

docker compose up -d
docker compose logs -f app
```

Caddy issues and renews the TLS certificate on its own. Nothing else to configure.

---

## Environment variables

| Variable | Default | Why it matters |
|---|---|---|
| `PONS_DOMAIN` | `Tsunami` | Shown in the message users sign at login. Set it to the real hostname so people can see what they're signing into. |
| `PONS_SECURE_COOKIES` | off | `1` marks the session cookie `Secure` and enables HSTS. **Required in production**, and it needs real HTTPS in front. |
| `PONS_TRUST_PROXY` | off | `1` makes rate limiting read `X-Forwarded-For`. Only turn this on when a proxy you control is in front — otherwise anyone can spoof their IP and bypass limits. |
| `PONS_RPC_URL` | public RPC | Your own endpoint. The public one is rate limited; depending on it to exit a position is a real operational risk. |
| `PONS_DB` | `./data/pons.sqlite` | Put this on the persistent volume. |
| `PONS_KEYSTORE_DIR` | `./data/keystores` | Same. **Losing this directory loses every agent's funds.** |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | The Docker image already sets `0.0.0.0`. |

---

## Backups

The keystore directory is the only thing that cannot be rebuilt. The database can be
re-indexed from chain; a lost keystore is lost money.

```bash
# Fly
fly ssh console -C "tar czf - /data/keystores" > keystores-$(date +%F).tgz

# VPS
docker compose exec app tar czf - /data/keystores > keystores-$(date +%F).tgz
```

Store that archive somewhere other than the server. The files are encrypted with each
user's password, so the archive alone is not enough to spend — but it is enough for
users to recover if the server is lost.

---

## What is already hardened

- **Wallet-signature login** — no passwords, no password database. Single-use nonce,
  session cookie `HttpOnly; SameSite=Strict`, `Secure` when configured.
- **Per-account isolation** — reading, configuring, running, and exporting a keystore
  are all blocked for anyone but the owner. Covered by `test/web.test.js`.
- **Rate limiting** — 20/min on the auth endpoints, 5/hour on agent creation, 240/min
  otherwise, per IP.
- **Security headers** — CSP, `X-Frame-Options: DENY`, `nosniff`, no referrer, HSTS
  when `PONS_SECURE_COOKIES=1`.
- **Non-root container** with the data directory on a volume.
- **Graceful shutdown** so SQLite closes cleanly instead of leaving a stale WAL.

## Before real funds

The execution layer ships in a later phase. When it does, deal with these first:

1. **Keystores off the application disk.** Today a server compromise gives an attacker
   every keystore file. They are still encrypted per user, so a weak user password is
   the weak link. Moving key material to a KMS/HSM, or at minimum an encrypted volume
   whose key does not live on the same box, is the right fix.
2. **Decide what you are, legally.** Holding many users' hot wallets is custody. That
   carries real regulatory exposure depending on your jurisdiction and volume. The
   more functions you can keep on keyless delegation (`setFeeRedirect`), the less of
   this you take on. Talk to a lawyer before scaling.
3. **Test on the Robinhood Chain testnet first.** Every signing path, with small
   amounts, before any mainnet ETH.
4. **Publish what the agent does.** If your token runs programmatic buybacks, saying so
   publicly is what separates a transparent treasury from a manipulation complaint.
