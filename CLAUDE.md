# Working in this repository

## Branches and pull requests (required)

- `main` is the stable base and the default branch. **Never commit or push directly to `main`.**
- Every change, however small, goes on its own branch cut from the latest `main`, and reaches
  `main` only through a pull request that the owner (Heang Senghong) reviews and merges.
- Never merge your own pull request, force-push to `main`, or rewrite `main`'s history.
- Keep each pull request to one coherent change, and describe what changed, why, and how it was
  verified.
- Before opening a pull request, run and pass what CI runs: `pnpm typecheck`, `pnpm test`
  (needs PostgreSQL; see README) and `pnpm build`.
- Once a branch's pull request has been merged, don't reuse it. Start the next piece of work on a
  fresh branch from the updated `main`.

## Project essentials

- Read `docs/architecture.md` (decisions, data model, authorization) and `docs/deployment.md`
  before making structural changes.
- Business rules are enforced in the API services (`apps/api/src/modules`, `apps/api/src/core`),
  never only in the web app. Routes validate input; services check permissions and state.
- Keep these decisions intact unless the owner changes them:
  - No automatic PO: a person selects the winning quote and a person generates the PO.
  - Cancelling or rejecting a PO reopens its quote comparison (fallback supplier).
  - Petty cash (< $100) needs only the HOD's acknowledgement and never enters sourcing or POs.
  - One PO per supplier, with multiple lines.
  - Spend by supplier is only for Procurement, Finance and leadership.
  - Store and department users never see prices or supplier identities.
  - Exporting is a separate permission from viewing.
  - Invoice / 3-way matching is out of scope.
- Schema changes go through Drizzle migrations (`pnpm db:generate`); never edit applied
  migrations. Transaction records are cancelled, not deleted.
- Add or update integration tests in `apps/api/test` for any change to workflow or permissions.
