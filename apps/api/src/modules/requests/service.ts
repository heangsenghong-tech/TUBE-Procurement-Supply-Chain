// Request Center: purchase requests (incl. petty cash), sample requests, service requests,
// approvals and tracking.
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type ApprovalActionInput, type PurchaseRequestInput, type SampleRequestInput, type SampleEvaluationStatus, type ServiceRequestInput
} from '@tube/shared';
import type { Db, DbOrTx, Tx } from '../../db/client';
import * as t from '../../db/schema';
import { type Actor, can, loadActor, requirePermission } from '../../core/actor';
import { act, approvalHistory, cancelOpenApproval, eligibility, pendingStepsFor, pickRule, startApproval } from '../../core/approvals';
import { audit } from '../../core/audit';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { lineAmount, sum } from '../../core/money';
import { nextNumber } from '../../core/numbering';
import { estimatedPrices } from '../catalog';

type Request = typeof t.requests.$inferSelect;

// ---------------- visibility ----------------
export function canViewRequest(actor: Actor, r: Pick<Request, 'requesterId' | 'orgUnitId'>) {
  return r.requesterId === actor.id || actor.hodUnitIds.includes(r.orgUnitId) || can(actor, 'request.view_all');
}

// Requesters never see prices. HODs see the estimated value of their unit's requests because
// they approve them; pricing roles see everything.
export function canSeeRequestValue(actor: Actor, r: Pick<Request, 'orgUnitId'>) {
  return can(actor, 'pricing.view') || actor.hodUnitIds.includes(r.orgUnitId);
}

function visibilityFilter(actor: Actor): SQL | undefined {
  if (can(actor, 'request.view_all')) return undefined;
  const clauses: SQL[] = [eq(t.requests.requesterId, actor.id)];
  if (actor.hodUnitIds.length) clauses.push(inArray(t.requests.orgUnitId, actor.hodUnitIds));
  return or(...clauses);
}

async function loadRequestForUpdate(tx: Tx, id: string) {
  const rows = await tx.execute<{ id: string }>(sql`select id from requests where id = ${id} for update`);
  if (!rows[0]) throw notFound('Request');
  return (await tx.query.requests.findFirst({ where: eq(t.requests.id, id) }))!;
}

async function unitForRequest(db: DbOrTx, actor: Actor, orgUnitId: string, track: 'store' | 'hq') {
  const unit = await db.query.orgUnits.findFirst({ where: and(eq(t.orgUnits.id, orgUnitId), eq(t.orgUnits.active, true)) });
  if (!unit) throw badRequest('Choose an active store or department.');
  if (unit.id !== actor.orgUnitId && !can(actor, 'request.view_all')) {
    throw forbidden('You can only raise requests for your own store or department.');
  }
  const expected = unit.type === 'store' ? 'store' : 'hq';
  if (track !== expected) throw badRequest(unit.type === 'store' ? `${unit.name} is a store — use the Store request type.` : `${unit.name} is an HQ department — use the HQ department request type.`);
  return unit;
}

type Handling = 'purchase' | 'sample' | 'service';
const DEFAULT_TYPE: Record<Handling, string | null> = { purchase: 'purchase_request', sample: 'new_item_sample', service: null };

// The request type chosen in "+ New Request": must be active and follow the right workflow.
async function resolveType(db: DbOrTx, typeId: string | undefined, handling: Handling) {
  const type = typeId
    ? await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.id, typeId) })
    : DEFAULT_TYPE[handling] ? await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.key, DEFAULT_TYPE[handling]!) }) : undefined;
  if (!type) throw badRequest('Choose a request type.');
  if (!type.active) throw badRequest(`"${type.name}" is no longer offered. Choose another request type.`);
  if (type.handling !== handling) throw badRequest(`"${type.name}" can't be submitted with this form.`);
  return type;
}

async function priceLines(db: DbOrTx, lines: PurchaseRequestInput['lines']) {
  const itemIds = lines.map((l) => l.itemId);
  const items = await db.select().from(t.items).where(and(inArray(t.items.id, itemIds), eq(t.items.active, true)));
  if (items.length !== new Set(itemIds).size) throw badRequest('One or more items are not in the active catalog.');
  const prices = await estimatedPrices(db, itemIds);
  const priced = lines.map((l, i) => {
    const item = items.find((it) => it.id === l.itemId)!;
    const price = prices.get(l.itemId) ?? 0;
    return { lineNo: i + 1, itemId: l.itemId, qty: l.qty, uom: item.uom, estUnitPrice: price, amount: lineAmount(l.qty, price) };
  });
  return {
    priced, total: sum(priced.map((p) => p.amount)),
    categories: [...new Set(items.map((i) => i.category))], procurementTypes: [...new Set(items.map((i) => i.procurementType))]
  };
}

// ---------------- purchase requests ----------------
export async function createPurchaseRequest(db: Db, actor: Actor, input: PurchaseRequestInput) {
  requirePermission(actor, 'request.create');
  const unit = await unitForRequest(db, actor, input.orgUnitId, input.track);
  const type = await resolveType(db, input.requestTypeId, 'purchase');
  const { priced, total, categories, procurementTypes } = await priceLines(db, input.lines);
  const { rule, steps } = await pickRule(db, 'request', total, {
    handling: 'purchase', requestTypeKey: type.key, track: input.track, orgUnitId: unit.id, categories, procurementTypes, urgent: !!input.isUrgent
  });
  // Petty cash is paid on the spot, so "urgent" adds nothing there.
  const urgent = !!input.isUrgent && !rule.isPettyCash;

  return db.transaction(async (tx) => {
    const number = await nextNumber(tx, 'PR');
    const [req] = await tx.insert(t.requests).values({
      number, kind: 'purchase', requestTypeId: type.id, track: input.track, orgUnitId: unit.id, requesterId: actor.id,
      status: 'pending_approval', isPettyCash: rule.isPettyCash, estimatedTotal: total,
      isUrgent: urgent, urgentReason: urgent ? input.urgentReason! : null,
      requiredDate: input.requiredDate ?? null, purpose: input.purpose ?? null, referenceUrl: input.referenceUrl ?? null
    }).returning();
    await tx.insert(t.requestLines).values(priced.map((p) => ({
      requestId: req!.id, lineNo: p.lineNo, itemId: p.itemId, qty: p.qty, uom: p.uom, estUnitPrice: p.estUnitPrice, status: 'pending_approval' as const
    })));
    const { autoApproved } = await startApproval(tx, { kind: 'request', documentId: req!.id, amount: total, orgUnitId: unit.id, rule, steps });
    if (autoApproved) await onRequestApproved(tx, req!);
    await audit(tx, { userId: actor.id, action: 'request.create', entityType: 'request', entityId: req!.id,
      after: { number, type: type.key, total, rule: rule.name, pettyCash: rule.isPettyCash, urgent, lines: priced.length } });
    return { id: req!.id, number, isPettyCash: rule.isPettyCash, isUrgent: urgent };
  });
}

async function onRequestApproved(tx: Tx, req: Request) {
  if (req.isPettyCash) {
    // Petty cash is paid directly: it goes to Finance's register, never to Procurement.
    await tx.update(t.requests).set({ status: 'petty_cash_approved', updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    await tx.update(t.requestLines).set({ status: 'petty_cash' }).where(and(eq(t.requestLines.requestId, req.id), eq(t.requestLines.status, 'pending_approval')));
  } else {
    // Purchases go to Review & Consolidate; service requests to Procurement's service queue.
    await tx.update(t.requests).set({ status: 'approved', updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    await tx.update(t.requestLines).set({ status: 'open' }).where(and(eq(t.requestLines.requestId, req.id), eq(t.requestLines.status, 'pending_approval')));
  }
}

export async function actOnRequest(db: Db, actor: Actor, requestId: string, input: ApprovalActionInput) {
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.status !== 'pending_approval') throw conflict('This request is not waiting for approval.');
    const { outcome } = await act(tx, actor, { kind: 'request', documentId: req.id, ownerId: req.requesterId, action: input.action, comment: input.comment });
    if (outcome === 'approved') await onRequestApproved(tx, req);
    if (outcome === 'rejected') {
      await tx.update(t.requests).set({ status: 'rejected', updatedAt: new Date() }).where(eq(t.requests.id, req.id));
      await tx.update(t.requestLines).set({ status: 'cancelled', cancelReason: 'Request rejected' })
        .where(and(eq(t.requestLines.requestId, req.id), eq(t.requestLines.status, 'pending_approval')));
    }
    if (outcome === 'changes_requested') {
      await tx.update(t.requests).set({ status: 'changes_requested', updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    }
    if (input.comment) await tx.insert(t.comments).values({ entityType: 'request', entityId: req.id, userId: actor.id, body: input.comment });
    return { outcome };
  });
}

async function loadForResubmit(db: DbOrTx, actor: Actor, requestId: string, kind: 'purchase' | 'service', input: { orgUnitId: string; track: string }) {
  const existing = await db.query.requests.findFirst({ where: eq(t.requests.id, requestId) });
  if (!existing || !canViewRequest(actor, existing)) throw notFound('Request');
  if (existing.requesterId !== actor.id) throw forbidden('Only the requester can resubmit this request.');
  if (existing.kind !== kind) throw badRequest('This form doesn\'t match the request.');
  if (input.orgUnitId !== existing.orgUnitId || input.track !== existing.track) throw badRequest('The store/department can\'t be changed on resubmission.');
  return existing;
}

// After "request changes", the requester edits and resubmits; the value is re-checked and a
// fresh approval chain starts. The earlier chain stays in the history.
export async function resubmitPurchaseRequest(db: Db, actor: Actor, requestId: string, input: PurchaseRequestInput) {
  const existing = await loadForResubmit(db, actor, requestId, 'purchase', input);
  const type = input.requestTypeId ? await resolveType(db, input.requestTypeId, 'purchase')
    : (await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.id, existing.requestTypeId) }))!;
  const { priced, total, categories, procurementTypes } = await priceLines(db, input.lines);
  const { rule, steps } = await pickRule(db, 'request', total, {
    handling: 'purchase', requestTypeKey: type.key, track: existing.track, orgUnitId: existing.orgUnitId, categories, procurementTypes, urgent: !!input.isUrgent
  });
  const urgent = !!input.isUrgent && !rule.isPettyCash;

  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.status !== 'changes_requested') throw conflict('This request is not waiting for changes.');
    const old = await tx.query.requestLines.findMany({ where: eq(t.requestLines.requestId, req.id) });
    await tx.update(t.requestLines).set({ status: 'cancelled', cancelReason: 'Replaced on resubmission' })
      .where(and(eq(t.requestLines.requestId, req.id), eq(t.requestLines.status, 'pending_approval')));
    const offset = Math.max(0, ...old.map((l) => l.lineNo));
    await tx.insert(t.requestLines).values(priced.map((p) => ({
      requestId: req.id, lineNo: offset + p.lineNo, itemId: p.itemId, qty: p.qty, uom: p.uom, estUnitPrice: p.estUnitPrice, status: 'pending_approval' as const
    })));
    await tx.update(t.requests).set({
      status: 'pending_approval', requestTypeId: type.id, isPettyCash: rule.isPettyCash, estimatedTotal: total,
      isUrgent: urgent, urgentReason: urgent ? input.urgentReason! : null,
      requiredDate: input.requiredDate ?? null, purpose: input.purpose ?? null, referenceUrl: input.referenceUrl ?? null, updatedAt: new Date()
    }).where(eq(t.requests.id, req.id));
    const { autoApproved } = await startApproval(tx, { kind: 'request', documentId: req.id, amount: total, orgUnitId: req.orgUnitId, rule, steps });
    if (autoApproved) await onRequestApproved(tx, { ...req, isPettyCash: rule.isPettyCash });
    await audit(tx, { userId: actor.id, action: 'request.resubmit', entityType: 'request', entityId: req.id,
      before: { total: req.estimatedTotal, urgent: req.isUrgent, lines: old.filter((l) => l.status === 'pending_approval').map((l) => ({ itemId: l.itemId, qty: l.qty })) },
      after: { total, rule: rule.name, urgent, lines: priced.map((p) => ({ itemId: p.itemId, qty: p.qty })) } });
    return { id: req.id, number: req.number };
  });
}

// ---------------- service requests ----------------
// A task for Procurement that isn't buying catalog items. The HOD acknowledges it (per the
// approval rules), then it waits in Procurement's service queue until someone takes and resolves it.
export async function createServiceRequest(db: Db, actor: Actor, input: ServiceRequestInput) {
  requirePermission(actor, 'request.create');
  const unit = await unitForRequest(db, actor, input.orgUnitId, input.track);
  const type = await resolveType(db, input.requestTypeId, 'service');
  const urgent = !!input.isUrgent;
  const { rule, steps } = await pickRule(db, 'request', 0, { handling: 'service', requestTypeKey: type.key, track: input.track, orgUnitId: unit.id, urgent });

  return db.transaction(async (tx) => {
    const number = await nextNumber(tx, 'SV');
    const [req] = await tx.insert(t.requests).values({
      number, kind: 'service', requestTypeId: type.id, track: input.track, orgUnitId: unit.id, requesterId: actor.id,
      status: 'pending_approval', isUrgent: urgent, urgentReason: urgent ? input.urgentReason! : null,
      requiredDate: input.requiredDate ?? null, purpose: input.description, referenceUrl: input.referenceUrl ?? null,
      details: { subject: input.subject }
    }).returning();
    const { autoApproved } = await startApproval(tx, { kind: 'request', documentId: req!.id, amount: 0, orgUnitId: unit.id, rule, steps });
    if (autoApproved) await onRequestApproved(tx, req!);
    await audit(tx, { userId: actor.id, action: 'service.create', entityType: 'request', entityId: req!.id,
      after: { number, type: type.key, subject: input.subject, rule: rule.name, urgent } });
    return { id: req!.id, number };
  });
}

export async function resubmitServiceRequest(db: Db, actor: Actor, requestId: string, input: ServiceRequestInput) {
  await loadForResubmit(db, actor, requestId, 'service', input);
  const type = await resolveType(db, input.requestTypeId, 'service');
  const urgent = !!input.isUrgent;
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.status !== 'changes_requested') throw conflict('This request is not waiting for changes.');
    const { rule, steps } = await pickRule(tx, 'request', 0, { handling: 'service', requestTypeKey: type.key, track: req.track, orgUnitId: req.orgUnitId, urgent });
    await tx.update(t.requests).set({
      status: 'pending_approval', requestTypeId: type.id, isUrgent: urgent, urgentReason: urgent ? input.urgentReason! : null,
      requiredDate: input.requiredDate ?? null, purpose: input.description, referenceUrl: input.referenceUrl ?? null,
      details: { subject: input.subject }, updatedAt: new Date()
    }).where(eq(t.requests.id, req.id));
    const { autoApproved } = await startApproval(tx, { kind: 'request', documentId: req.id, amount: 0, orgUnitId: req.orgUnitId, rule, steps });
    if (autoApproved) await onRequestApproved(tx, req);
    await audit(tx, { userId: actor.id, action: 'service.resubmit', entityType: 'request', entityId: req.id,
      before: { subject: (req.details as { subject?: string }).subject, description: req.purpose }, after: { subject: input.subject, description: input.description } });
    return { id: req.id, number: req.number };
  });
}

// Procurement picks up an approved service request (or hands it to a colleague).
export async function assignServiceRequest(db: Db, actor: Actor, requestId: string, assigneeId?: string) {
  requirePermission(actor, 'procurement.operate');
  const who = assigneeId ?? actor.id;
  const assignee = await loadActor(db, who);
  if (!assignee || !can(assignee, 'procurement.operate')) throw badRequest('Assign it to someone in Procurement.');
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.kind !== 'service') throw badRequest('Only service requests are assigned.');
    if (req.status !== 'approved' && req.status !== 'in_progress') throw conflict('This request isn\'t waiting for Procurement.');
    await tx.update(t.requests).set({ status: 'in_progress', assigneeId: who, updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    await audit(tx, { userId: actor.id, action: 'service.assign', entityType: 'request', entityId: req.id, before: { assigneeId: req.assigneeId }, after: { assigneeId: who } });
  });
}

export async function resolveServiceRequest(db: Db, actor: Actor, requestId: string, resolution: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.kind !== 'service') throw badRequest('Only service requests are resolved here.');
    if (req.status !== 'in_progress') throw conflict('Take the request first, then resolve it.');
    await tx.update(t.requests).set({ status: 'completed', resolution, completedAt: new Date(), updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    await tx.insert(t.comments).values({ entityType: 'request', entityId: req.id, userId: actor.id, body: `Resolved: ${resolution}` });
    await audit(tx, { userId: actor.id, action: 'service.resolve', entityType: 'request', entityId: req.id, after: { resolution } });
  });
}

export async function serviceQueue(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'procurement.operate');
  const assignee = alias(t.users, 'assignee');
  const rows = await db.select({
    r: t.requests, typeName: t.requestTypes.name, unitName: t.orgUnits.name, requesterName: t.users.name, assigneeName: assignee.name
  }).from(t.requests)
    .innerJoin(t.requestTypes, eq(t.requestTypes.id, t.requests.requestTypeId))
    .innerJoin(t.orgUnits, eq(t.orgUnits.id, t.requests.orgUnitId))
    .innerJoin(t.users, eq(t.users.id, t.requests.requesterId))
    .leftJoin(assignee, eq(assignee.id, t.requests.assigneeId))
    .where(and(eq(t.requests.kind, 'service'), inArray(t.requests.status, ['approved', 'in_progress'])))
    .orderBy(desc(t.requests.isUrgent), asc(t.requests.submittedAt));
  return rows.map(({ r, typeName, unitName, requesterName, assigneeName }) => ({
    id: r.id, number: r.number, status: r.status, typeName, subject: String((r.details as { subject?: string }).subject ?? ''),
    orgUnitName: unitName, requesterName, assigneeId: r.assigneeId, assigneeName, isUrgent: r.isUrgent, urgentReason: r.urgentReason,
    requiredDate: r.requiredDate, submittedAt: r.submittedAt
  }));
}

export async function cancelRequest(db: Db, actor: Actor, requestId: string, reason: string) {
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (!canViewRequest(actor, req)) throw notFound('Request');
    if (req.requesterId !== actor.id && !can(actor, 'procurement.operate')) throw forbidden('Only the requester or Procurement can cancel this request.');
    if (!isCancellable(req)) throw conflict('This request can no longer be cancelled here. If items are already being sourced, ask Procurement to cancel the lines.');
    if (req.kind === 'purchase') {
      const busy = await tx.query.requestLines.findFirst({ where: and(eq(t.requestLines.requestId, req.id), inArray(t.requestLines.status, ['in_qcs', 'ordered', 'delivered'])) });
      if (busy) throw conflict('Some items are already being sourced. Ask Procurement to cancel them.');
    }
    await cancelOpenApproval(tx, 'request', req.id);
    await tx.update(t.requestLines).set({ status: 'cancelled', cancelReason: reason })
      .where(and(eq(t.requestLines.requestId, req.id), inArray(t.requestLines.status, ['pending_approval', 'open'])));
    await tx.update(t.requests).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(t.requests.id, req.id));
    await audit(tx, { userId: actor.id, action: 'request.cancel', entityType: 'request', entityId: req.id, before: { status: req.status }, comment: reason });
  });
}

function isCancellable(r: Pick<Request, 'kind' | 'status'>) {
  if (r.kind === 'sample') return !['pass', 'fail', 'not_meet_requirement', 'cancelled'].includes(r.status);
  if (r.kind === 'service') return ['pending_approval', 'changes_requested', 'approved', 'in_progress'].includes(r.status);
  return ['pending_approval', 'changes_requested', 'approved'].includes(r.status);
}

// Procurement cancels a single line that's waiting in the review queue (e.g. no longer needed).
export async function cancelRequestLine(db: Db, actor: Actor, lineId: string, reason: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const line = await tx.query.requestLines.findFirst({ where: eq(t.requestLines.id, lineId) });
    if (!line) throw notFound('Request line');
    await loadRequestForUpdate(tx, line.requestId);
    if (line.status !== 'open') throw conflict('Only lines waiting for Procurement can be cancelled here.');
    await tx.update(t.requestLines).set({ status: 'cancelled', cancelReason: reason }).where(eq(t.requestLines.id, lineId));
    await recomputeRequestStatus(tx, line.requestId);
    await audit(tx, { userId: actor.id, action: 'request_line.cancel', entityType: 'request_line', entityId: lineId, comment: reason });
  });
}

// Derives a purchase request's overall status from its lines once it's with Procurement.
export async function recomputeRequestStatus(tx: Tx, requestId: string) {
  const req = await tx.query.requests.findFirst({ where: eq(t.requests.id, requestId) });
  if (!req || req.kind !== 'purchase' || req.isPettyCash) return;
  if (!['approved', 'in_progress', 'ordered', 'completed'].includes(req.status)) return;
  const lines = (await tx.query.requestLines.findMany({ where: eq(t.requestLines.requestId, requestId) }))
    .filter((l) => l.cancelReason !== 'Replaced on resubmission');
  const live = lines.filter((l) => l.status !== 'cancelled');
  let status: Request['status'];
  if (!live.length) status = 'cancelled';
  else if (live.every((l) => l.status === 'delivered')) status = 'completed';
  else if (live.every((l) => l.status === 'ordered' || l.status === 'delivered')) status = 'ordered';
  else if (live.some((l) => l.status !== 'open')) status = 'in_progress';
  else status = 'approved';
  if (status !== req.status) {
    await tx.update(t.requests).set({
      status, updatedAt: new Date(),
      completedAt: status === 'completed' ? new Date() : null,
      cancelledAt: status === 'cancelled' ? new Date() : req.cancelledAt
    }).where(eq(t.requests.id, requestId));
  }
}

// ---------------- sample requests ----------------
export async function createSampleRequest(db: Db, actor: Actor, input: SampleRequestInput) {
  requirePermission(actor, 'request.create');
  const unit = await unitForRequest(db, actor, input.orgUnitId, input.track);
  const type = await resolveType(db, input.requestTypeId, 'sample');
  return db.transaction(async (tx) => {
    const number = await nextNumber(tx, 'SR');
    const details = {
      itemName: input.itemName, timeline: input.timeline, quantity: input.quantity, placeOfUsage: input.placeOfUsage,
      size: input.size, material: input.material, colorCode: input.colorCode
    };
    const [req] = await tx.insert(t.requests).values({
      number, kind: 'sample', requestTypeId: type.id, track: input.track, orgUnitId: unit.id, requesterId: actor.id, status: 'sourcing',
      purpose: input.purpose, referenceUrl: input.referenceUrl ?? null, details
    }).returning();
    await audit(tx, { userId: actor.id, action: 'sample.create', entityType: 'request', entityId: req!.id, after: { number, ...details } });
    return { id: req!.id, number };
  });
}

// The evaluation loop: requester (who tries the sample), their HOD, or Procurement update it.
export async function evaluateSample(db: Db, actor: Actor, requestId: string, status: SampleEvaluationStatus, comment?: string) {
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (req.kind !== 'sample' || !canViewRequest(actor, req)) throw notFound('Sample request');
    const allowed = req.requesterId === actor.id || actor.hodUnitIds.includes(req.orgUnitId) || can(actor, 'procurement.operate');
    if (!allowed) throw forbidden('Only the requester, their HOD or Procurement can update the evaluation.');
    if (req.status === 'cancelled') throw conflict('This sample request was cancelled.');
    await tx.update(t.requests).set({
      status, updatedAt: new Date(), completedAt: ['pass', 'fail', 'not_meet_requirement'].includes(status) ? new Date() : null
    }).where(eq(t.requests.id, req.id));
    if (comment) await tx.insert(t.comments).values({ entityType: 'request', entityId: req.id, userId: actor.id, body: comment });
    await audit(tx, { userId: actor.id, action: 'sample.evaluate', entityType: 'request', entityId: req.id, before: { status: req.status }, after: { status }, comment });
  });
}

// ---------------- petty cash ----------------
export async function reconcilePettyCash(db: Db, actor: Actor, requestId: string, input: { receiptReference: string; actualAmount?: number; note?: string }) {
  requirePermission(actor, 'pettycash.reconcile');
  return db.transaction(async (tx) => {
    const req = await loadRequestForUpdate(tx, requestId);
    if (!req.isPettyCash) throw badRequest('This is not a petty cash request.');
    if (req.status !== 'petty_cash_approved') throw conflict(req.status === 'petty_cash_reconciled' ? 'Already reconciled.' : 'The HOD has not acknowledged this request yet.');
    await tx.update(t.requests).set({
      status: 'petty_cash_reconciled', reconciledAt: new Date(), reconciledBy: actor.id,
      reconcileReference: input.receiptReference, reconcileAmount: input.actualAmount ?? null, reconcileNote: input.note ?? null,
      completedAt: new Date(), updatedAt: new Date()
    }).where(eq(t.requests.id, req.id));
    await audit(tx, { userId: actor.id, action: 'pettycash.reconcile', entityType: 'request', entityId: req.id, after: input });
  });
}

// ---------------- comments ----------------
export async function addComment(db: Db, actor: Actor, requestId: string, body: string) {
  const req = await db.query.requests.findFirst({ where: eq(t.requests.id, requestId) });
  if (!req || !canViewRequest(actor, req)) throw notFound('Request');
  await db.insert(t.comments).values({ entityType: 'request', entityId: req.id, userId: actor.id, body });
}

// ---------------- reading ----------------
export interface RequestListFilters {
  scope?: 'mine' | 'unit' | 'all';
  kind?: 'purchase' | 'sample' | 'service';
  urgent?: boolean;
  pettyCash?: boolean;
  status?: string[];
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listRequests(db: DbOrTx, actor: Actor, f: RequestListFilters = {}) {
  const where: (SQL | undefined)[] = [visibilityFilter(actor)];
  if (f.scope === 'mine') where.push(eq(t.requests.requesterId, actor.id));
  if (f.scope === 'unit') where.push(actor.hodUnitIds.length ? inArray(t.requests.orgUnitId, actor.hodUnitIds) : sql`false`);
  if (f.kind) where.push(eq(t.requests.kind, f.kind));
  if (f.pettyCash !== undefined) where.push(eq(t.requests.isPettyCash, f.pettyCash));
  if (f.urgent !== undefined) where.push(eq(t.requests.isUrgent, f.urgent));
  if (f.status?.length) where.push(inArray(t.requests.status, f.status as Request['status'][]));
  if (f.q) where.push(or(ilike(t.requests.number, `%${f.q}%`), ilike(t.requests.purpose, `%${f.q}%`)));

  const rows = await db.select({
    r: t.requests, unitName: t.orgUnits.name, requesterName: t.users.name, typeName: t.requestTypes.name,
    lineCount: sql<number>`(select count(*)::int from request_lines l where l.request_id = ${t.requests.id} and l.status <> 'cancelled')`
  }).from(t.requests)
    .innerJoin(t.orgUnits, eq(t.orgUnits.id, t.requests.orgUnitId))
    .innerJoin(t.users, eq(t.users.id, t.requests.requesterId))
    .innerJoin(t.requestTypes, eq(t.requestTypes.id, t.requests.requestTypeId))
    .where(and(...where))
    .orderBy(desc(t.requests.submittedAt))
    .limit(Math.min(f.limit ?? 50, 200)).offset(f.offset ?? 0);

  return rows.map(({ r, unitName, requesterName, typeName, lineCount }) => ({
    id: r.id, number: r.number, kind: r.kind, track: r.track, status: r.status, isPettyCash: r.isPettyCash,
    typeName, isUrgent: r.isUrgent,
    orgUnitName: unitName, requesterName, submittedAt: r.submittedAt, lineCount,
    itemName: r.kind === 'sample' ? String((r.details as { itemName?: string }).itemName ?? '') : null,
    subject: r.kind === 'service' ? String((r.details as { subject?: string }).subject ?? '') : null,
    estimatedTotal: canSeeRequestValue(actor, r) ? r.estimatedTotal : null
  }));
}

export async function getRequest(db: DbOrTx, actor: Actor, id: string) {
  const r = await db.query.requests.findFirst({ where: eq(t.requests.id, id) });
  if (!r || !canViewRequest(actor, r)) throw notFound('Request');
  const showValue = canSeeRequestValue(actor, r);
  const unit = await db.query.orgUnits.findFirst({ where: eq(t.orgUnits.id, r.orgUnitId) });
  const requester = await db.query.users.findFirst({ where: eq(t.users.id, r.requesterId) });
  const type = (await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.id, r.requestTypeId) }))!;
  const assignee = r.assigneeId ? await db.query.users.findFirst({ where: eq(t.users.id, r.assigneeId) }) : null;

  const lines = await db.select({ l: t.requestLines, code: t.items.code, description: t.items.description })
    .from(t.requestLines).innerJoin(t.items, eq(t.items.id, t.requestLines.itemId))
    .where(eq(t.requestLines.requestId, id)).orderBy(asc(t.requestLines.lineNo));

  // Traceability: which comparison sheets and POs each line went into.
  const lineIds = lines.map((x) => x.l.id);
  const qcsLinks = lineIds.length ? await db.select({ lineId: t.qcsItemLines.requestLineId, number: t.quoteComparisons.number, qcsId: t.quoteComparisons.id })
    .from(t.qcsItemLines).innerJoin(t.qcsItems, eq(t.qcsItems.id, t.qcsItemLines.qcsItemId))
    .innerJoin(t.quoteComparisons, eq(t.quoteComparisons.id, t.qcsItems.qcsId))
    .where(inArray(t.qcsItemLines.requestLineId, lineIds)) : [];
  const poLinks = lineIds.length ? await db.select({ lineId: t.poLineAllocations.requestLineId, number: t.purchaseOrders.number, poId: t.purchaseOrders.id, status: t.purchaseOrders.status })
    .from(t.poLineAllocations).innerJoin(t.poLines, eq(t.poLines.id, t.poLineAllocations.poLineId))
    .innerJoin(t.purchaseOrders, eq(t.purchaseOrders.id, t.poLines.poId))
    .where(inArray(t.poLineAllocations.requestLineId, lineIds)) : [];

  const comments = await db.select({ id: t.comments.id, body: t.comments.body, createdAt: t.comments.createdAt, userName: t.users.name })
    .from(t.comments).innerJoin(t.users, eq(t.users.id, t.comments.userId))
    .where(and(eq(t.comments.entityType, 'request'), eq(t.comments.entityId, id))).orderBy(asc(t.comments.createdAt));

  // The rule name reveals the value band (e.g. "$100 – $299"), so it's hidden from people who can't see prices.
  const approvals = (await approvalHistory(db, 'request', id)).map((c) => (showValue ? c : { ...c, ruleName: r.isPettyCash ? 'Petty cash' : 'Approval' }));
  const current = approvals.at(-1);
  const pendingStep = current?.status === 'pending' ? current.steps.find((s) => s.status === 'pending') : undefined;
  let canAct = false;
  if (pendingStep) {
    const inst = await db.query.approvalInstances.findFirst({ where: eq(t.approvalInstances.id, current!.id) });
    const step = await db.query.approvalSteps.findFirst({ where: and(eq(t.approvalSteps.instanceId, inst!.id), eq(t.approvalSteps.status, 'pending')) });
    canAct = !!step && !!(await eligibility(db, actor, step, r.requesterId));
  }

  let reconciledByName: string | null = null;
  if (r.reconciledBy) reconciledByName = (await db.query.users.findFirst({ where: eq(t.users.id, r.reconciledBy) }))?.name ?? null;

  return {
    id: r.id, number: r.number, kind: r.kind, track: r.track, status: r.status, isPettyCash: r.isPettyCash,
    requestType: { id: type.id, key: type.key, name: type.name },
    isUrgent: r.isUrgent, urgentReason: r.urgentReason,
    subject: r.kind === 'service' ? String((r.details as { subject?: string }).subject ?? '') : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null, resolution: r.resolution,
    orgUnit: { id: unit!.id, name: unit!.name, type: unit!.type, ownership: unit!.ownership },
    requester: { id: requester!.id, name: requester!.name },
    estimatedTotal: showValue ? r.estimatedTotal : null,
    requiredDate: r.requiredDate, purpose: r.purpose, referenceUrl: r.referenceUrl, details: r.details,
    submittedAt: r.submittedAt, completedAt: r.completedAt, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason,
    reconciliation: r.reconciledAt ? {
      at: r.reconciledAt, by: reconciledByName,
      receiptReference: r.reconcileReference, amount: can(actor, 'pettycash.view') ? r.reconcileAmount : null, note: r.reconcileNote
    } : null,
    lines: lines.map(({ l, code, description }) => ({
      id: l.id, lineNo: l.lineNo, itemId: l.itemId, itemCode: code, itemDescription: description, qty: l.qty, uom: l.uom,
      status: l.status, cancelReason: l.cancelReason,
      estUnitPrice: showValue ? l.estUnitPrice : null,
      qcs: qcsLinks.filter((q) => q.lineId === l.id).map((q) => ({ id: q.qcsId, number: q.number })),
      pos: poLinks.filter((p) => p.lineId === l.id).map((p) => ({ id: p.poId, number: p.number, status: p.status }))
    })),
    approvals,
    comments,
    permissions: {
      canAct,
      canCancel: (r.requesterId === actor.id || can(actor, 'procurement.operate')) && isCancellable(r),
      canResubmit: r.requesterId === actor.id && r.status === 'changes_requested',
      canEvaluate: r.kind === 'sample' && r.status !== 'cancelled' &&
        (r.requesterId === actor.id || actor.hodUnitIds.includes(r.orgUnitId) || can(actor, 'procurement.operate')),
      canReconcile: r.status === 'petty_cash_approved' && can(actor, 'pettycash.reconcile'),
      canTake: r.kind === 'service' && (r.status === 'approved' || r.status === 'in_progress') && r.assigneeId !== actor.id && can(actor, 'procurement.operate'),
      canResolve: r.kind === 'service' && r.status === 'in_progress' && can(actor, 'procurement.operate')
    }
  };
}

// The approvals inbox: every request and PO step this person can act on now.
export async function approvalInbox(db: DbOrTx, actor: Actor) {
  const pending = await pendingStepsFor(db, actor);
  const out: {
    kind: 'request' | 'po'; documentId: string; number: string; title: string; typeName: string; amount: number | null;
    stepLabel: string; override: boolean; urgent: boolean; submittedAt: Date; by: string;
  }[] = [];
  for (const { step, instance } of pending) {
    if (instance.documentKind === 'request') {
      const r = await db.query.requests.findFirst({ where: eq(t.requests.id, instance.documentId) });
      if (!r) continue;
      const how = await eligibility(db, actor, step, r.requesterId);
      if (!how) continue;
      const unit = await db.query.orgUnits.findFirst({ where: eq(t.orgUnits.id, r.orgUnitId) });
      const requester = await db.query.users.findFirst({ where: eq(t.users.id, r.requesterId) });
      const type = await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.id, r.requestTypeId) });
      const subject = r.kind === 'service' ? ` · ${String((r.details as { subject?: string }).subject ?? '')}` : '';
      out.push({ kind: 'request', documentId: r.id, number: r.number, title: `${unit?.name ?? ''}${r.isPettyCash ? ' · Petty cash' : ''}${subject}`,
        typeName: type?.name ?? '', amount: r.kind === 'service' ? null : r.estimatedTotal, stepLabel: step.actionLabel,
        override: how === 'override', urgent: r.isUrgent, submittedAt: r.submittedAt, by: requester?.name ?? '' });
    } else {
      const po = await db.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, instance.documentId) });
      if (!po) continue;
      const how = await eligibility(db, actor, step, po.createdBy);
      if (!how) continue;
      const supplier = await db.query.suppliers.findFirst({ where: eq(t.suppliers.id, po.supplierId) });
      const creator = await db.query.users.findFirst({ where: eq(t.users.id, po.createdBy) });
      out.push({ kind: 'po', documentId: po.id, number: po.number, title: supplier?.name ?? '', typeName: 'Purchase order', amount: po.total,
        stepLabel: step.actionLabel, override: how === 'override', urgent: await poIsUrgent(db, po.id), submittedAt: po.createdAt, by: creator?.name ?? '' });
    }
  }
  // Urgent first, then oldest first.
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent) || +a.submittedAt - +b.submittedAt);
}

// A PO is urgent when any request it fulfils was raised as urgent.
export async function poIsUrgent(db: DbOrTx, poId: string) {
  const rows = await db.select({ id: t.requests.id }).from(t.poLines)
    .innerJoin(t.poLineAllocations, eq(t.poLineAllocations.poLineId, t.poLines.id))
    .innerJoin(t.requestLines, eq(t.requestLines.id, t.poLineAllocations.requestLineId))
    .innerJoin(t.requests, eq(t.requests.id, t.requestLines.requestId))
    .where(and(eq(t.poLines.poId, poId), eq(t.requests.isUrgent, true))).limit(1);
  return !!rows[0];
}
