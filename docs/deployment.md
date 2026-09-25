# Deployment

The same Docker Compose setup runs on a **company server** or a **VPS**. You need a Linux machine
with Docker, about 2 GB RAM and 20 GB disk, and a name people can reach it by.

## 1. Google sign-in (once)

1. Google Cloud Console → create a project (e.g. "Tube Procurement") under the Tube Cafe organisation.
2. **APIs & Services → OAuth consent screen:** User type **Internal** (only your Workspace accounts). App name "Tube Procurement", support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID:** type **Web application**.
   - Authorised redirect URI: `https://<your domain>/auth/google/callback`
4. Copy the **Client ID** and **Client secret** into `deploy/.env`.

Only verified accounts from `GOOGLE_ALLOWED_DOMAINS` (default `tubecafecambodia.com`) are accepted,
and only if an administrator has added that email in **Users & Stores**.

## 2. Configure and start

```bash
git clone <this repository> /opt/tube-procurement && cd /opt/tube-procurement/deploy
cp .env.example .env         # then edit: DOMAIN, passwords, Google keys, BOOTSTRAP_ADMIN_EMAIL
docker compose up -d --build
```

- **VPS with a public domain:** point the domain's DNS at the server; leave `TLS_MODE` empty — Caddy gets a Let's Encrypt certificate automatically.
- **Company-network server without a public domain:** set `TLS_MODE=tls internal`. Caddy issues its own certificate; install Caddy's root certificate on staff devices (or use your company's certificate). Google sign-in still works because the redirect happens in the browser.

On first start the app creates the tables, loads roles, the approval matrix, the real item &
supplier master, and the administrator from `BOOTSTRAP_ADMIN_EMAIL`. Sign in with that Google
account, then:

1. **Users & Stores → Stores & departments:** add every store (or import CSV).
2. **Users & Stores → Users:** add people with their store/department and role (or import CSV).
3. Set each store's/department's **HOD** — they approve that unit's requests.
4. Give the Head of Finance, CEO and Supply Chain Manager their roles.

## 3. Training environment

A second, completely separate stack for practising — its own database with demo stores, people
and transactions:

```bash
cd deploy && docker compose -f docker-compose.training.yml up -d --build   # http://<server>:8081
docker compose -f docker-compose.training.yml down -v                      # wipe and start fresh
```

Trainees pick a demo person (store barista, HOD, Finance, CEO, buyer…) to try each role. The
training database also holds the real price list, so **if port 8081 is reachable beyond a trusted
room, set `TRAINING_GOOGLE_CLIENT_ID/SECRET`**: the demo picker then unlocks only after a company
Google sign-in (add `http://<server>:8081/auth/google/callback` to the OAuth client's redirect URIs,
or put training behind HTTPS too).

## 4. Backups

```bash
scripts/backup.sh                                  # writes deploy/backups/tube-YYYY-MM-DD_HHMM.dump, keeps 30 days
scripts/restore.sh deploy/backups/<file>.dump      # asks for confirmation; keeps the old data as tube_restore_old
```

Schedule `backup.sh` daily with cron and copy `deploy/backups/` off the machine (NAS, another
server, or cloud storage). A backup you can't restore isn't a backup — test a restore in the
Training stack from time to time.

## 5. Updating

```bash
git pull && cd deploy && docker compose up -d --build
```

Database migrations run automatically at start-up.
