# Tube Procurement & Supply Chain

Company-wide procurement system for **Tube Cafe Co., Ltd.** It covers purchase requests from
every store and HQ department, approvals under the real approval matrix, consolidation, quote
comparison, purchase orders, delivery, petty cash reconciliation, contracts and live reporting.
It keeps the design and workflow of the validated prototype, and the server enforces every
permission.

- **Architecture and decisions:** [docs/architecture.md](docs/architecture.md)
- **Deploying (company server or VPS), Google sign-in, backups, Training:** [docs/deployment.md](docs/deployment.md)

## Develop locally

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createdb tube_dev
cat > apps/api/.env <<'EOF'
APP_ENV=training
DEV_LOGIN=1
DATABASE_URL=postgres://<user>:<password>@localhost:5432/tube_dev
EOF
pnpm dev:api     # http://localhost:8080 — migrates, seeds master data + demo data
pnpm dev:web     # http://localhost:5173 — pick a demo person on the sign-in page
```

## Tests

```bash
createdb tube_test
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/tube_test pnpm test
pnpm typecheck
```

The tests cover the approval matrix and who may act on each step, petty cash, consolidation,
multi-line POs, the fallback supplier, visibility rules, export authorization, CSRF, Google
account checks, CSV import validation and the append-only audit log.
