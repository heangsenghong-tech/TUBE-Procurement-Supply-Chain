// JSON API. Each route: signed-in person (loaded in app.ts) → validated input → service.
// Services perform every permission and state check; routes contain no business rules.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ALL_PERMISSIONS, PERMISSIONS, approvalActionInput, approvalRuleInput, assignServiceInput, requestTypeInput, resolveServiceInput, serviceRequestInput, cancelInput, commentInput, contractInput, createQcsInput,
  deliverPoInput, directPoInput, generatePoFromQcsInput, itemInput, itemPriceInput, orgUnitInput, pettyCashReconcileInput,
  purchaseRequestInput, quotationInput, sampleEvaluationInput, sampleRequestInput, selectQuotationInput, supplierInput, userInput
} from '@tube/shared';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Actor } from '../core/actor';
import * as req from '../modules/requests/service';
import * as proc from '../modules/procurement/service';
import * as master from '../modules/master/service';
import * as imports from '../modules/master/import';
import * as reports from '../modules/reports/service';
import { requirePermission } from '../core/actor';
import { badRequest } from '../core/errors';

const idParam = z.object({ id: z.string().uuid() });
const actorOf = (r: FastifyRequest) => r.actor as Actor;
const id = (r: FastifyRequest) => idParam.parse(r.params).id;

export function apiRoutes(config: Config, db: Db) {
  return async function (app: FastifyInstance) {
    // ---------------- me ----------------
    app.get('/me', async (r) => {
      const a = actorOf(r);
      const unit = a.orgUnitId ? (await master.listOrgUnits(db)).find((u) => u.id === a.orgUnitId) : null;
      return {
        id: a.id, email: a.email, name: a.name, roles: [...a.roles], permissions: [...a.permissions],
        orgUnit: unit ? { id: unit.id, name: unit.name, type: unit.type } : null,
        hodUnitIds: a.hodUnitIds, environment: config.APP_ENV
      };
    });
    app.get('/org-units', async () => master.listOrgUnits(db));
    app.get('/dashboard', async (r) => reports.dashboard(db, actorOf(r)));

    // ---------------- requests ----------------
    app.get('/requests', async (r) => {
      const q = z.object({
        scope: z.enum(['mine', 'unit', 'all']).optional(), kind: z.enum(['purchase', 'sample', 'service']).optional(),
        urgent: z.enum(['true', 'false']).optional(),
        pettyCash: z.enum(['true', 'false']).optional(), status: z.string().optional(), q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional()
      }).parse(r.query);
      return req.listRequests(db, actorOf(r), {
        ...q, pettyCash: q.pettyCash === undefined ? undefined : q.pettyCash === 'true',
        urgent: q.urgent === undefined ? undefined : q.urgent === 'true', status: q.status?.split(',')
      });
    });
    app.get('/requests/:id', async (r) => req.getRequest(db, actorOf(r), id(r)));
    app.post('/requests/purchase', async (r) => req.createPurchaseRequest(db, actorOf(r), purchaseRequestInput.parse(r.body)));
    app.put('/requests/:id/purchase', async (r) => req.resubmitPurchaseRequest(db, actorOf(r), id(r), purchaseRequestInput.parse(r.body)));
    app.post('/requests/sample', async (r) => req.createSampleRequest(db, actorOf(r), sampleRequestInput.parse(r.body)));
    app.post('/requests/service', async (r) => req.createServiceRequest(db, actorOf(r), serviceRequestInput.parse(r.body)));
    app.put('/requests/:id/service', async (r) => req.resubmitServiceRequest(db, actorOf(r), id(r), serviceRequestInput.parse(r.body)));
    app.post('/requests/:id/assign', async (r) => { await req.assignServiceRequest(db, actorOf(r), id(r), assignServiceInput.parse(r.body ?? {}).assigneeId); return { ok: true }; });
    app.post('/requests/:id/resolve', async (r) => { await req.resolveServiceRequest(db, actorOf(r), id(r), resolveServiceInput.parse(r.body).resolution); return { ok: true }; });
    app.get('/procurement/service-queue', async (r) => req.serviceQueue(db, actorOf(r)));
    app.get('/request-types', async (r) => master.listRequestTypes(db, actorOf(r), z.object({ all: z.enum(['true', 'false']).optional() }).parse(r.query).all === 'true'));
    app.post('/request-types', async (r) => master.upsertRequestType(db, actorOf(r), null, requestTypeInput.parse(r.body)));
    app.put('/request-types/:id', async (r) => master.upsertRequestType(db, actorOf(r), id(r), requestTypeInput.parse(r.body)));
    app.post('/requests/:id/approval', async (r) => req.actOnRequest(db, actorOf(r), id(r), approvalActionInput.parse(r.body)));
    app.post('/requests/:id/cancel', async (r) => { await req.cancelRequest(db, actorOf(r), id(r), cancelInput.parse(r.body).reason); return { ok: true }; });
    app.post('/requests/:id/evaluation', async (r) => {
      const b = sampleEvaluationInput.parse(r.body);
      await req.evaluateSample(db, actorOf(r), id(r), b.status, b.comment);
      return { ok: true };
    });
    app.post('/requests/:id/reconcile', async (r) => { await req.reconcilePettyCash(db, actorOf(r), id(r), pettyCashReconcileInput.parse(r.body)); return { ok: true }; });
    app.post('/requests/:id/comments', async (r) => { await req.addComment(db, actorOf(r), id(r), commentInput.parse(r.body).body); return { ok: true }; });
    app.post('/request-lines/:id/cancel', async (r) => { await req.cancelRequestLine(db, actorOf(r), id(r), cancelInput.parse(r.body).reason); return { ok: true }; });
    app.get('/approvals/inbox', async (r) => req.approvalInbox(db, actorOf(r)));

    // ---------------- catalog & master data ----------------
    app.get('/items', async (r) => {
      const q = z.object({ q: z.string().max(100).optional(), includeInactive: z.enum(['true', 'false']).optional() }).parse(r.query);
      return master.listItems(db, actorOf(r), { q: q.q, includeInactive: q.includeInactive === 'true' });
    });
    app.post('/items', async (r) => master.upsertItem(db, actorOf(r), null, itemInput.parse(r.body)));
    app.put('/items/:id', async (r) => master.upsertItem(db, actorOf(r), id(r), itemInput.parse(r.body)));
    app.post('/items/:id/prices', async (r) => { await master.setItemPrice(db, actorOf(r), id(r), itemPriceInput.parse(r.body)); return { ok: true }; });
    app.delete('/item-prices/:id', async (r) => { await master.removeItemPrice(db, actorOf(r), id(r)); return { ok: true }; });
    app.get('/suppliers', async (r) => master.listSuppliers(db, actorOf(r)));
    app.post('/suppliers', async (r) => master.upsertSupplier(db, actorOf(r), null, supplierInput.parse(r.body)));
    app.put('/suppliers/:id', async (r) => master.upsertSupplier(db, actorOf(r), id(r), supplierInput.parse(r.body)));
    app.post('/org-units', async (r) => master.upsertOrgUnit(db, actorOf(r), null, orgUnitInput.parse(r.body)));
    app.put('/org-units/:id', async (r) => master.upsertOrgUnit(db, actorOf(r), id(r), orgUnitInput.parse(r.body)));

    app.post('/import/:kind', async (r) => {
      const { kind } = z.object({ kind: z.enum(['items', 'suppliers', 'org-units', 'users']) }).parse(r.params);
      const { csv, dryRun } = z.object({ csv: z.string().min(1).max(4_000_000), dryRun: z.boolean().default(true) }).parse(r.body);
      const fn = { items: imports.importItems, suppliers: imports.importSuppliers, 'org-units': imports.importOrgUnits, users: imports.importUsers }[kind];
      return fn(db, actorOf(r), csv, dryRun);
    });
    app.get('/import/:kind/template', async (r, reply) => {
      const { kind } = z.object({ kind: z.enum(['items', 'suppliers', 'org-units', 'users']) }).parse(r.params);
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="tube-${kind}-template.csv"`).send(imports.IMPORT_TEMPLATES[kind]);
    });

    // ---------------- users, roles, settings ----------------
    app.get('/users', async (r) => master.listUsers(db, actorOf(r)));
    app.post('/users', async (r) => master.upsertUser(db, actorOf(r), null, userInput.parse(r.body)));
    app.put('/users/:id', async (r) => master.upsertUser(db, actorOf(r), id(r), userInput.parse(r.body)));
    app.get('/roles', async () => ({ roles: await master.listRoles(db), permissions: ALL_PERMISSIONS.map((k) => ({ key: k, description: PERMISSIONS[k] })) }));
    app.put('/roles/:key/permissions', async (r) => {
      const { key } = z.object({ key: z.string().max(60) }).parse(r.params);
      const { permissions } = z.object({ permissions: z.array(z.string()).max(50) }).parse(r.body);
      await master.setRolePermissions(db, actorOf(r), key, permissions);
      return { ok: true };
    });
    app.get('/approval-rules', async (r) => { requirePermission(actorOf(r), 'settings.manage'); return master.listApprovalRules(db); });
    app.post('/approval-rules', async (r) => master.createApprovalRule(db, actorOf(r), approvalRuleInput.parse(r.body)));
    app.put('/approval-rules/:id', async (r) => { await master.updateApprovalRule(db, actorOf(r), id(r), approvalRuleInput.parse(r.body)); return { ok: true }; });
    app.post('/approval-rules/preview', async (r) => master.previewRouting(db, actorOf(r), z.object({
      documentKind: z.enum(['request', 'po']), amount: z.number().min(0).max(100_000_000),
      handling: z.enum(['purchase', 'service']).optional(), requestTypeKey: z.string().max(40).optional(),
      orgUnitId: z.string().uuid().optional(), categories: z.array(z.enum(['Food', 'Non-food'])).optional(),
      procurementTypes: z.array(z.enum(['Direct', 'Indirect'])).optional(), urgent: z.boolean().optional()
    }).parse(r.body)));

    // ---------------- procurement ----------------
    app.get('/procurement/review', async (r) => proc.reviewQueue(db, actorOf(r)));
    app.get('/qcs', async (r) => proc.listQcs(db, actorOf(r), z.object({ status: z.string().optional() }).parse(r.query).status));
    app.get('/qcs/:id', async (r) => proc.getQcs(db, actorOf(r), id(r)));
    app.post('/qcs', async (r) => proc.createQcs(db, actorOf(r), createQcsInput.parse(r.body)));
    app.post('/qcs/:id/cancel', async (r) => { await proc.cancelQcs(db, actorOf(r), id(r), cancelInput.parse(r.body).reason); return { ok: true }; });
    app.post('/qcs/:id/generate-po', async (r) => proc.generatePosFromQcs(db, actorOf(r), id(r), generatePoFromQcsInput.parse(r.body ?? {})));
    app.post('/qcs-items/:id/quotations', async (r) => proc.upsertQuotation(db, actorOf(r), id(r), quotationInput.parse(r.body)));
    app.post('/qcs-items/:id/select', async (r) => proc.selectQuotation(db, actorOf(r), id(r), selectQuotationInput.parse(r.body)));
    app.delete('/quotations/:id', async (r) => { await proc.removeQuotation(db, actorOf(r), id(r)); return { ok: true }; });

    app.get('/pos', async (r) => proc.listPos(db, actorOf(r), z.object({ status: z.string().optional() }).parse(r.query)));
    app.get('/pos/:id', async (r) => proc.getPo(db, actorOf(r), id(r)));
    app.post('/pos', async (r) => proc.createDirectPo(db, actorOf(r), directPoInput.parse(r.body)));
    app.post('/pos/:id/approval', async (r) => proc.actOnPo(db, actorOf(r), id(r), approvalActionInput.parse(r.body)));
    app.post('/pos/:id/cancel', async (r) => { await proc.cancelPo(db, actorOf(r), id(r), cancelInput.parse(r.body).reason); return { ok: true }; });
    app.post('/pos/:id/deliver', async (r) => { await proc.deliverPo(db, actorOf(r), id(r), deliverPoInput.parse(r.body ?? {}).note); return { ok: true }; });

    // ---------------- contracts ----------------
    app.get('/contracts', async (r) => master.listContracts(db, actorOf(r)));
    app.post('/contracts', async (r) => master.upsertContract(db, actorOf(r), null, contractInput.parse(r.body)));
    app.put('/contracts/:id', async (r) => master.upsertContract(db, actorOf(r), id(r), contractInput.parse(r.body)));

    // ---------------- reports ----------------
    app.get('/reports/spend', async (r) => {
      const q = z.object({ period: z.enum(['day', 'week', 'month', 'quarter', 'semester', 'year']).default('month') }).parse(r.query);
      return reports.spend(db, actorOf(r), q.period);
    });
    app.get('/reports/monthly', async (r) => reports.monthlySummary(db, actorOf(r), z.object({ month: z.string() }).parse(r.query).month));
    app.get('/audit', async (r) => {
      const q = z.object({ entityType: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().optional() }).parse(r.query);
      return reports.auditEntries(db, actorOf(r), q);
    });

    // ---------------- exports (server decides who may download) ----------------
    const exporters: Record<string, (db: Db, a: Actor) => Promise<string>> = {
      'price-list': reports.exportPriceList, contracts: reports.exportContracts, 'quote-comparisons': reports.exportQcs,
      'purchase-orders': reports.exportPos, requests: reports.exportRequests
    };
    app.get('/exports/:name', async (r, reply) => {
      const { name } = z.object({ name: z.string() }).parse(r.params);
      const fn = exporters[name];
      if (!fn) throw badRequest('Unknown export.');
      const body = await fn(db, actorOf(r));
      const stamp = new Date().toISOString().slice(0, 10);
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="tube-${name}-${stamp}.csv"`).send(body);
    });
  };
}
