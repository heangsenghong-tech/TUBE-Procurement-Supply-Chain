# Architecture — Tube Procurement & Supply Chain, Version 1

Version 0 was the Claude.ai artifact prototype. V1 keeps its validated workflow, wording and
look, and moves it onto a real backend where **every rule is enforced by the server**.

## Decisions (agreed in review)

| # | Decision |
|---|---|
| 1 | Invoice / 3-way matching is **out of V1** (Finance's domain; the handoff excluded it). |
| 2 | Testing uses a **separate Training environment** (own database, demo data), not an in-app toggle. |
| 3 | Spend **by supplier** is visible only to Procurement, Finance and leadership (`spend.supplier.view`). |
| 4 | **Petty cash (< $100):** a PR is still raised; only the requester's HOD acknowledges it; it goes to Finance's Petty Cash register for reconciliation against the physical invoice and **never** enters Review, Quote Comparison or PO. |
| 5 | **One PO per supplier**, with multiple item lines. |
| 6 | **Sign in with Google** (Google Workspace), no passwords. Only people an administrator has added can sign in. Named outside accounts may be allowed individually (`GOOGLE_ALLOWED_EMAILS`) — e.g. the Finance proxy's Gmail. |
| 7 | Supplier contact file to follow; the master was seeded from the live prototype (160 items, 26 suppliers). |
| 8 | Hosting undecided — Docker Compose deploys identically to a company server or a VPS. |
| 9 | "Urgent Purchase" is an **urgent flag with a reason** on any purchase or service request, rather than a separate type, so urgent IT, equipment or maintenance requests keep their own type and rules. |

Carried over deliberately from the handoff:
- **No automatic PO.** A person selects the winning quote; a person clicks Generate PO.
- **Fallback supplier.** Cancelling or rejecting a PO supersedes that selection, **reopens** its
  comparison sheet with every quote kept, and returns the PR lines to it. Direct-PO lines return
  to Review & Consolidate (a prototype bug, fixed).
- **Traceability.** PO → QCS → PR lines → requester/store, all by foreign key.
- **Viewing ≠ exporting.** Export Authorization (`export.sensitive`) is separate from pricing access;
  exports are generated and checked by the server.

## Stack

| Layer | Choice |
|---|---|
| Web | React 19 + TypeScript + Vite + Tailwind 4, TanStack Query, React Router |
| API | Node 22 + TypeScript + Fastify 5, REST, Zod validation |
| Database | PostgreSQL 16 via Drizzle ORM (SQL migrations checked in) |
| Auth | Google OpenID Connect (code flow + PKCE, ID token verified with Google's keys, Workspace domain enforced), server-side sessions in httpOnly cookies |
| Deploy | Docker Compose: PostgreSQL + app + Caddy (automatic HTTPS) |

All open source. No per-user or per-transaction fees. Infrastructure (server/VPS, domain, off-site backup storage) is the only cost.

## Repository

```
apps/api/src/
  core/        actor (who is signed in + permissions) · approvals (engine) · audit · numbering ·
               google (OIDC) · sessions · money · errors
  modules/     requests · procurement · master (items, suppliers, stores, users, contracts, rules, CSV import) · reports
  routes/      auth.ts (Google, sign-out, training picker) · api.ts (JSON API — no business rules)
  db/          schema.ts · migrations/ · seed/reference.ts (roles, approval matrix, real master data) · seed/training.ts
apps/api/test/ integration tests against PostgreSQL (workflow + HTTP)
apps/web/src/  pages/ (Submit & Track, request, approvals, sign-in) · workspace/ (tiles and panels) · lib/
packages/shared/ permission keys, default roles, statuses, input schemas (used by both sides)
data/seed/     real item & supplier master
deploy/        docker-compose.yml (production) · docker-compose.training.yml · Caddyfile · .env.example
scripts/       backup.sh · restore.sh
```

## How authorization works

1. Every `/api` request resolves the session cookie to a user and **reloads their roles,
   permissions and HOD units from the database** (changes apply immediately; disabled users are out).
2. State-changing requests must carry `X-Tube-Request: 1`, which cross-site pages can't send (CSRF).
3. Routes only validate input; **services** make every permission and state check inside a
   database transaction, locking the affected rows (`SELECT … FOR UPDATE`) so two people can't
   act on the same step or PR line at once.
4. Reads are scoped: requesters see their own requests; HODs see their unit's; `request.view_all`
   sees everything. Prices, estimated values and supplier identities are removed from responses
   for people without `pricing.view` / `supplier.view` — including the approval rule's value band.

### Request Center
**+ New Request** offers the active `request_types`, grouped as in master spec §7. Each type follows
one workflow (`handling`), and administrators add or retire types in **Request Types**:

| Workflow | Seeded types | Flow |
|---|---|---|
| purchase | Purchase Request, IT Procurement, Equipment, Furniture, Uniform, Office Supplies | Catalog items → approval by value (or petty cash) → Review & Consolidate → QCS/PO |
| sample | New Item / Sample Request | Sourcing → evaluation (Pass/Fail loop) |
| service | Supplier Request, Price Inquiry, Contract Request, Maintenance | Approved by its **estimated cost** on the same tiers as a purchase (below $100 the HOD acknowledges; never petty cash) → Procurement's **Service Requests** queue → taken by a buyer → resolved with an outcome the requester sees |

Supply chain and project types arrive with their modules. A type's key and workflow are frozen
once it has requests. Any purchase or service request can be marked **urgent** (with a reason).
Urgent items go first in approvers' inboxes, Review & Consolidate and the service queue, and feed
the dashboard's "urgent purchases %". Urgency is dropped for petty cash, which is paid on the spot.

### Approval engine
Rules (`approval_rules` + `approval_rule_steps`) are chosen by document kind and amount, plus
optional conditions, and they're editable in **Approval Rules**:
- Request rules: workflow (purchase/service), request types, store vs HQ, specific stores/departments,
  item categories (every line), Direct/Indirect (every line), urgency.
- PO rules: item categories, Direct/Indirect, urgency (a PO is urgent if any request it fulfils is).

The most specific matching rule wins; ties go to the lower priority number. Petty cash rules only
ever apply to purchase requests, so a service request can never fall into petty cash. Two active
rules with identical conditions and overlapping amounts are refused. Rules are switched off, never
deleted. **Who would approve this?** previews the chain, with real approver names, before anyone
submits. The chosen rule's steps are copied
into an `approval_instance` so later edits don't change approvals already under way. A step is
either the requesting unit's **HOD** (resolved live from `org_units.hod_user_id`) or a **role**
(`finance_head`, `ceo`, `supply_chain_manager`, …). Nobody approves their own document. If a step
has no eligible approver (no HOD set, or the HOD raised it), a holder of `approval.override`
(Supply Chain Manager) may act — recorded as an override. Reject / Request changes require a reason.

Seeded with the company's confirmed structure — one pattern for both tracks. "HOD" is whoever heads
the requesting unit:

| Value | Track A — HQ departments | Track B — Stores | PO |
|---|---|---|---|
| < $100 | Petty cash: the department's HOD acknowledges → Finance register | Petty cash: the store's own Store/Area Manager (its HOD) acknowledges → Finance register | No approval |
| $100–$299 | Department HOD reviews → Head of Finance approves | Head of Operation reviews → Head of Finance approves | Supply Chain Manager → Head of Finance |
| $300+ | Department HOD reviews → Head of Finance reviews → CEO approves | Head of Operation reviews → Head of Finance reviews → CEO approves | Head of Finance → CEO |

"Head of Finance" and "Head of Operation" are roles, so anyone holding the role can act on that step
(e.g. both the Head of Finance and the Accounting Manager). Service requests (maintenance, contracts…)
use the same tiers on their estimated cost, except that below $100 they go to Procurement rather than
petty cash. Store ownership doesn't change routing:
KDT follows the Track B process but is tagged **company-owned** (Tube Cafe Co., Ltd. pays), while
other stores are franchisee-billed. The named approvers are in `data/org/approvers.csv`, ready for
**Users & Stores → Bulk add people**.

### Roles (configurable)
Super Admin · CEO · Supply Chain Manager · Head of Operation · Procurement Officer · Head of Finance · Finance ·
Warehouse · Store/Department User · Export Authorization. Each is a bundle of permission keys
(`packages/shared/src/permissions.ts`), editable per role in the database.

## Data model (V1)

- **Organisation:** `org_units` (stores & departments, ownership, HOD) · `users` · `roles` · `role_permissions` · `user_roles` · `sessions`
- **Master data:** `items` (code, category, direct/indirect, UOM, estimated cost, reference flag) · `uoms` (normalised) · `suppliers` · `item_supplier_prices` (primary/backup rank; superseded prices kept as history)
- **Requests:** `request_types` · `requests` (purchase, sample or service; type; petty cash and urgent flags; service assignee and outcome; kind-specific details) · `request_lines` · `comments`
- **Approvals:** `approval_rules` · `approval_rule_steps` · `approval_instances` · `approval_steps` (who acted, when, override, comment)
- **Sourcing:** `quote_comparisons` · `qcs_items` · `qcs_item_lines` (consolidated PR lines) · `quotations` (asking vs negotiated) · `qcs_selections` (every pick, superseded or active)
- **Purchasing:** `purchase_orders` · `po_lines` (unit, asking and last-paid price → savings & avoidance) · `po_line_allocations` (store allocation)
- **Other:** `contracts` (pointer to the document, never the document) · `document_sequences` (PR-2026-000125 style, gap-free) · `audit_log` (append-only, enforced by a database trigger)

Money is `numeric(14,4)`, quantities `numeric(14,3)`. Transaction records are cancelled, never deleted.

## Not in V1 (planned phases)

Designed for, not yet built — each is additive and doesn't change the tables above:
1. **Tasks, SLAs, notifications and the Control Tower** (auto-created next-step tasks, overdue detection, team workload).
2. **Receiving & inventory:** GRN against PO lines (received / damaged / accepted, batch, expiry, photo), stock movements, warehouses, deliveries with proof of delivery.
3. **Projects** (new store opening etc.) linking requests and POs.
4. **Supplier evaluation**, file attachments (photos, quotes), email/Telegram notifications.
5. Invoice / 3-way match only if Finance asks for it (decision 1).
