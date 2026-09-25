# Tube Procurement & Supply Chain

The Procurement & Supply Chain app for **Tube Cafe Co., Ltd.**, running as an independent, self-hosted web app. The company owns both the server and the data.

It is the same app as the Claude artifact prototype (`claude.ai/artifact/NTwRth4JdpMw3Fg8BAR8MR`). The screens, workflow (PR → approval → review & consolidation → quote comparison → PO → delivery), approval matrix, Sample Requests, Contract Register, print layouts, CSV exports and Testing Mode are all unchanged. The only difference is what runs underneath it:

| Before (Claude artifact) | Now (independent app) |
|---|---|
| Claude artifact database | SQLite database file on your own server |
| Claude sign-in | Email + password accounts created by your administrator |
| Claude share list (50-invite cap) | No user limit, no per-user fees |
| Live sync via Claude | Live sync via the app server (Server-Sent Events) |
| Access checks only in the page | Access checks in the page **and enforced by the server** |
| No backup | One-click backup + command-line backup |

## What's in the box

```
public/index.html          the app page (the original, with minimal edits, listed below)
public/js/tube-runtime.js  replaces the Claude runtime (database, sign-in, downloads) with this server
public/login.html          sign-in
public/setup.html          first-run: create the administrator
public/account.html        change your own password
public/admin.html          user administration, backup, activity log
server/                    Node.js server (no npm dependencies, uses Node's built-in SQLite)
data/seed/                 the real Item & Supplier Master exported from the live prototype
                           (160 items, 26 suppliers with contacts & payment terms)
test/                      automated tests (npm test)
```

### Changes to the original page
The workflow logic is unchanged. Only these edits were made:
- The logo now loads from `/assets/tube-logo.png` instead of Claude's file store.
- `tube-runtime.js` is loaded before the app script.
- In the name menu (top right), the "sign out via Claude.ai" text is replaced with **Change password**, **User administration** (administrators only) and **Sign out**.
- A home-screen icon and app manifest were added, so "Add to Home Screen" on a phone installs it like an app.

## Run it

You need **Node.js 22.5 or newer**. There's nothing else to install.

```bash
npm start                  # http://localhost:8080
```

With Docker:

```bash
docker compose up -d --build    # http://<server>:8080, data kept in the "tube-data" volume
```

On first open, the app asks you to **create the administrator account**. That account automatically gets Procurement Workspace and Export Authorization access. The real Item & Supplier Master loads automatically into a new, empty database. PRs, POs, comparisons, contracts and sample requests start empty, as agreed in the handoff.

### Adding people
**Your name (top right) → User administration → Add a user.** Set a temporary password and send it to them privately. They can change it under **their name → Change password**.

- Everyone can **Submit & Track** PRs and Sample Requests and act on Approvals.
- **Procurement Workspace** and **Export Authorization** work the same way as before. You can tick them when adding a user, or people can press **Request Access** and a current member approves them on the Workspace tab.
- **Disable** removes someone's access immediately. Their past records stay.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `DATA_DIR` | `./data/runtime` | Where the database file `tube.sqlite` lives |
| `TRUST_PROXY` | `0` | Set to `1` when behind nginx/Caddy, so it reads the real client IP and HTTPS status |
| `COOKIE_SECURE` | `0` | Set to `1` once the app is served over HTTPS |

**Use HTTPS in production.** Put the app behind Caddy or nginx with a certificate (Caddy handles this automatically), then set `TRUST_PROXY=1` and `COOKIE_SECURE=1`.

## Backup and restore
- **From the browser:** User administration → **Download backup**. You get one `.sqlite` file containing everything.
- **From the server:** `npm run admin -- backup /path/to/backup.sqlite`. This is safe to run while the app is running, and fits a daily cron job.
- **Restore:** stop the app, replace `DATA_DIR/tube.sqlite` with the backup file, then start it again.

## Command-line administration

```bash
npm run admin -- create-admin hong@example.com "Heang Senghong"   # prompts for a password
npm run admin -- reset-password someone@example.com
npm run admin -- list-users
npm run admin -- backup
```

## Security notes
- Passwords are stored as scrypt hashes. Sessions use HttpOnly, SameSite cookies and expire after 30 days. Repeated failed sign-ins are throttled.
- The **server refuses** writes the access model doesn't allow:
  - Only Procurement Workspace members can change items, suppliers, quote comparisons, POs, contracts or approval settings.
  - Only current members can add people to the Workspace or Export lists.
  - Anyone signed in can request access, submit PRs and Sample Requests, and act on PR approvals.
- Every change is recorded in an **activity log** (who, when, before → after), visible under User administration.
- **Known limit, same as the prototype:** any signed-in user's browser can still *read* item prices and PO values, because the Submit & Track tab uses them to calculate PR value and spend. Hiding prices from store users completely needs the planned Version 1 rebuild (role-based access per field), which is outlined in the architecture proposal.

## Costs
The software is free: open source, with no per-user or per-transaction fees. What you pay for is where it runs, e.g. a small VPS (roughly US$5–20/month is enough for this workload), a domain name if you want one, and optional off-site backup storage.
