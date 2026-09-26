// Configurable approval engine.
//
// A rule is chosen by document kind and amount, plus optional conditions (request type, handling,
// store/HQ, store or department, item categories, Direct/Indirect, urgent). Its steps are copied
// into an approval instance so later rule edits never change an approval already under way.
// Steps run strictly in order, and each action is checked against who is signed in:
//   - HOD steps: the current Head of Department of the request's store/department
//   - role steps: anyone holding that role (e.g. finance_head, ceo)
// Nobody approves their own document. If a step has no eligible approver at all (no HOD set,
// or the HOD raised the request themselves), a holder of `approval.override` may act, and that
// is recorded as an override.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ApprovalConditions } from '@tube/shared';
import type { DbOrTx, Tx } from '../db/client';
import * as t from '../db/schema';
import type { Actor } from './actor';
import { audit } from './audit';
import { badRequest, conflict, forbidden } from './errors';

type DocumentKind = 'request' | 'po';

// What a rule's conditions are checked against.
export interface RoutingContext {
  handling?: 'purchase' | 'sample' | 'service';
  requestTypeKey?: string;
  track?: 'store' | 'hq';
  orgUnitId?: string;
  categories?: string[];        // distinct item categories on the document
  procurementTypes?: string[];  // distinct Direct/Indirect on the document
  urgent?: boolean;
}

export function matchesConditions(conditions: ApprovalConditions, ctx: RoutingContext) {
  const allIn = (have: string[] | undefined, allowed: string[]) => !!have?.length && have.every((h) => allowed.includes(h));
  if (conditions.handling !== undefined && conditions.handling !== ctx.handling) return false;
  if (conditions.requestTypeKeys && !conditions.requestTypeKeys.includes(ctx.requestTypeKey ?? '')) return false;
  if (conditions.track !== undefined && conditions.track !== ctx.track) return false;
  if (conditions.orgUnitIds && !conditions.orgUnitIds.includes(ctx.orgUnitId ?? '')) return false;
  if (conditions.categories && !allIn(ctx.categories, conditions.categories)) return false;
  if (conditions.procurementTypes && !allIn(ctx.procurementTypes, conditions.procurementTypes)) return false;
  if (conditions.urgent !== undefined && conditions.urgent !== !!ctx.urgent) return false;
  return true;
}

export const specificity = (c: ApprovalConditions) => Object.keys(c).length;

// The most specific active rule whose amount range and conditions match (ties: lower priority
// number first). Petty cash rules only ever apply to purchase requests.
export async function pickRule(db: DbOrTx, kind: DocumentKind, amount: number, ctx: RoutingContext = {}) {
  const rules = await db.query.approvalRules.findMany({
    where: and(eq(t.approvalRules.documentKind, kind), eq(t.approvalRules.active, true)),
    orderBy: [asc(t.approvalRules.priority)]
  });
  const matches = rules.filter((r) =>
    amount >= r.minAmount && (r.maxAmount == null || amount < r.maxAmount) &&
    (!r.isPettyCash || (kind === 'request' && ctx.handling === 'purchase')) &&
    matchesConditions(r.conditions as ApprovalConditions, ctx));
  matches.sort((a, b) => specificity(b.conditions as ApprovalConditions) - specificity(a.conditions as ApprovalConditions) || a.priority - b.priority);
  const rule = matches[0];
  if (!rule) {
    throw badRequest(`No approval rule covers this ${kind === 'po' ? 'PO' : 'request'} ($${amount.toFixed(2)}). Ask an administrator to check the approval rules.`);
  }
  const steps = await db.query.approvalRuleSteps.findMany({ where: eq(t.approvalRuleSteps.ruleId, rule.id), orderBy: [asc(t.approvalRuleSteps.seq)] });
  return { rule, steps };
}

export async function startApproval(tx: Tx, args: {
  kind: DocumentKind; documentId: string; amount: number; orgUnitId: string | null;
  rule: typeof t.approvalRules.$inferSelect; steps: (typeof t.approvalRuleSteps.$inferSelect)[];
}) {
  const [instance] = await tx.insert(t.approvalInstances).values({
    documentKind: args.kind, documentId: args.documentId, ruleId: args.rule.id, ruleName: args.rule.name,
    amount: args.amount, status: args.steps.length ? 'pending' : 'approved',
    completedAt: args.steps.length ? null : new Date()
  }).returning();
  if (args.steps.length) {
    await tx.insert(t.approvalSteps).values(args.steps.map((s, i) => ({
      instanceId: instance!.id, seq: s.seq, approverType: s.approverType, roleKey: s.roleKey,
      orgUnitId: s.approverType === 'hod' ? args.orgUnitId : null,
      actionLabel: s.actionLabel, status: i === 0 ? 'pending' as const : 'waiting' as const
    })));
  }
  return { instance: instance!, autoApproved: args.steps.length === 0 };
}

type Step = typeof t.approvalSteps.$inferSelect;

// Who may act on a step. `ownerId` is the person whose document it is (requester / PO creator).
export async function eligibility(db: DbOrTx, actor: Actor, step: Step, ownerId: string): Promise<'approver' | 'override' | null> {
  const eligibleIds = await eligibleApproverIds(db, step);
  const realApprovers = eligibleIds.filter((id) => id !== ownerId);
  if (actor.id !== ownerId && eligibleIds.includes(actor.id)) return 'approver';
  if (realApprovers.length === 0 && actor.permissions.has('approval.override') && actor.id !== ownerId) return 'override';
  return null;
}

async function eligibleApproverIds(db: DbOrTx, step: Step): Promise<string[]> {
  if (step.approverType === 'hod') {
    if (!step.orgUnitId) return [];
    const rows = await db.select({ id: t.users.id }).from(t.orgUnits)
      .innerJoin(t.users, and(eq(t.users.id, t.orgUnits.hodUserId), eq(t.users.active, true)))
      .where(eq(t.orgUnits.id, step.orgUnitId));
    return rows.map((r) => r.id);
  }
  if (!step.roleKey) return [];
  const rows = await db.select({ id: t.users.id }).from(t.userRoles)
    .innerJoin(t.roles, eq(t.roles.id, t.userRoles.roleId))
    .innerJoin(t.users, and(eq(t.users.id, t.userRoles.userId), eq(t.users.active, true)))
    .where(eq(t.roles.key, step.roleKey));
  return rows.map((r) => r.id);
}

export type ApprovalOutcome = 'advanced' | 'approved' | 'rejected' | 'changes_requested';

// Applies an approve / reject / request-changes action to the current step of the document's
// open approval. Locks the instance row so two approvers can't act on the same step at once.
export async function act(tx: Tx, actor: Actor, args: {
  kind: DocumentKind; documentId: string; ownerId: string; action: 'approve' | 'reject' | 'request_changes'; comment?: string;
}): Promise<{ outcome: ApprovalOutcome; step: Step }> {
  if (args.action !== 'approve' && !args.comment?.trim()) throw badRequest('Please give a reason.');
  const locked = await tx.execute<{ id: string }>(sql`
    select id from approval_instances
    where document_kind = ${args.kind} and document_id = ${args.documentId} and status = 'pending'
    for update`);
  const instanceId = locked[0]?.id;
  if (!instanceId) throw conflict('This is not waiting for approval.');

  const steps = await tx.query.approvalSteps.findMany({ where: eq(t.approvalSteps.instanceId, instanceId), orderBy: [asc(t.approvalSteps.seq)] });
  const current = steps.find((s) => s.status === 'pending');
  if (!current) throw conflict('This is not waiting for approval.');

  const how = await eligibility(tx, actor, current, args.ownerId);
  if (!how) {
    throw forbidden(actor.id === args.ownerId
      ? 'You can\'t approve your own request.'
      : `This step is waiting for ${await describeApprover(tx, current)}.`);
  }

  const now = new Date();
  const stepStatus = args.action === 'approve' ? 'approved' : args.action === 'reject' ? 'rejected' : 'changes_requested';
  await tx.update(t.approvalSteps).set({
    status: stepStatus, actedBy: actor.id, actedAt: now, actedAsOverride: how === 'override', comment: args.comment ?? null
  }).where(eq(t.approvalSteps.id, current.id));

  let outcome: ApprovalOutcome;
  if (args.action === 'approve') {
    const next = steps.find((s) => s.seq > current.seq && s.status === 'waiting');
    if (next) {
      await tx.update(t.approvalSteps).set({ status: 'pending' }).where(eq(t.approvalSteps.id, next.id));
      outcome = 'advanced';
    } else {
      await tx.update(t.approvalInstances).set({ status: 'approved', completedAt: now }).where(eq(t.approvalInstances.id, instanceId));
      outcome = 'approved';
    }
  } else {
    const waitingIds = steps.filter((s) => s.status === 'waiting').map((s) => s.id);
    if (waitingIds.length) await tx.update(t.approvalSteps).set({ status: 'cancelled' }).where(inArray(t.approvalSteps.id, waitingIds));
    await tx.update(t.approvalInstances).set({ status: args.action === 'reject' ? 'rejected' : 'changes_requested', completedAt: now })
      .where(eq(t.approvalInstances.id, instanceId));
    outcome = args.action === 'reject' ? 'rejected' : 'changes_requested';
  }

  await audit(tx, {
    userId: actor.id, action: `approval.${args.action}${how === 'override' ? '.override' : ''}`,
    entityType: args.kind, entityId: args.documentId,
    after: { step: current.seq, label: current.actionLabel, outcome }, comment: args.comment
  });
  return { outcome, step: current };
}

export async function cancelOpenApproval(tx: Tx, kind: DocumentKind, documentId: string) {
  const open = await tx.query.approvalInstances.findMany({
    where: and(eq(t.approvalInstances.documentKind, kind), eq(t.approvalInstances.documentId, documentId), eq(t.approvalInstances.status, 'pending'))
  });
  for (const inst of open) {
    await tx.update(t.approvalInstances).set({ status: 'cancelled', completedAt: new Date() }).where(eq(t.approvalInstances.id, inst.id));
    await tx.update(t.approvalSteps).set({ status: 'cancelled' })
      .where(and(eq(t.approvalSteps.instanceId, inst.id), inArray(t.approvalSteps.status, ['pending', 'waiting'])));
  }
}

export async function describeApprover(db: DbOrTx, step: Step) {
  if (step.approverType === 'hod') {
    if (!step.orgUnitId) return 'the HOD';
    const unit = await db.query.orgUnits.findFirst({ where: eq(t.orgUnits.id, step.orgUnitId) });
    const hod = unit?.hodUserId ? await db.query.users.findFirst({ where: eq(t.users.id, unit.hodUserId) }) : null;
    return hod ? `${hod.name} (HOD, ${unit!.name})` : `the HOD of ${unit?.name ?? 'this unit'} (none assigned yet)`;
  }
  const role = step.roleKey ? await db.query.roles.findFirst({ where: eq(t.roles.key, step.roleKey) }) : null;
  return role?.name ?? step.roleKey ?? 'an approver';
}

// Every approval chain for a document, oldest first, with approver names — for display.
export async function approvalHistory(db: DbOrTx, kind: DocumentKind, documentId: string) {
  const instances = await db.query.approvalInstances.findMany({
    where: and(eq(t.approvalInstances.documentKind, kind), eq(t.approvalInstances.documentId, documentId)),
    orderBy: [asc(t.approvalInstances.createdAt)]
  });
  const out = [];
  for (const inst of instances) {
    const steps = await db.query.approvalSteps.findMany({ where: eq(t.approvalSteps.instanceId, inst.id), orderBy: [asc(t.approvalSteps.seq)] });
    const actorIds = steps.map((s) => s.actedBy).filter((x): x is string => !!x);
    const names = actorIds.length ? await db.select({ id: t.users.id, name: t.users.name }).from(t.users).where(inArray(t.users.id, actorIds)) : [];
    out.push({
      id: inst.id, ruleName: inst.ruleName, status: inst.status, createdAt: inst.createdAt, completedAt: inst.completedAt,
      steps: await Promise.all(steps.map(async (s) => ({
        seq: s.seq, actionLabel: s.actionLabel, status: s.status, approver: await describeApprover(db, s),
        actedBy: names.find((n) => n.id === s.actedBy)?.name ?? null, actedAt: s.actedAt,
        override: s.actedAsOverride, comment: s.comment
      })))
    });
  }
  return out;
}

// Pending steps this person can act on right now (their approval inbox).
export async function pendingStepsFor(db: DbOrTx, actor: Actor) {
  const rows = await db.select({ step: t.approvalSteps, instance: t.approvalInstances })
    .from(t.approvalSteps).innerJoin(t.approvalInstances, eq(t.approvalInstances.id, t.approvalSteps.instanceId))
    .where(and(eq(t.approvalSteps.status, 'pending'), eq(t.approvalInstances.status, 'pending')));
  return rows;
}
