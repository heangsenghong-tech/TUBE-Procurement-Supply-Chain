// PostgreSQL schema (Drizzle ORM). Money is numeric(14,4); quantities numeric(14,3).
// Transaction records are never hard-deleted — they're cancelled, and every change is audited.
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn, bigserial, boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid
} from 'drizzle-orm/pg-core';

const money = (name: string) => numeric(name, { precision: 14, scale: 4, mode: 'number' });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3, mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const pk = () => uuid('id').primaryKey().defaultRandom();

// ---------------- enums ----------------
export const orgUnitType = pgEnum('org_unit_type', ['store', 'department']);
export const ownership = pgEnum('ownership', ['franchiser', 'franchisee']);
export const track = pgEnum('track', ['store', 'hq']);
export const procurementType = pgEnum('procurement_type', ['Direct', 'Indirect']);
export const itemCategory = pgEnum('item_category', ['Food', 'Non-food']);
export const supplierCategory = pgEnum('supplier_category', ['Food', 'Non-food', 'Both']);
// purchase: catalog items → Procurement sourcing · sample: evaluate before buying ·
// service: a task for Procurement that isn't an item purchase (new supplier, price inquiry, contract, maintenance)
export const requestKind = pgEnum('request_kind', ['purchase', 'sample', 'service']);
export const requestGroup = pgEnum('request_group', ['procurement', 'supply_chain', 'projects', 'other']);
export const requestStatus = pgEnum('request_status', [
  'pending_approval', 'changes_requested', 'approved', 'in_progress', 'ordered', 'completed', 'rejected', 'cancelled',
  'petty_cash_approved', 'petty_cash_reconciled',
  'sourcing', 'under_review', 'under_evaluation', 'under_consideration', 'pass', 'fail', 'not_meet_requirement'
]);
export const lineStatus = pgEnum('line_status', ['pending_approval', 'open', 'in_qcs', 'ordered', 'delivered', 'cancelled', 'petty_cash']);
export const documentKind = pgEnum('document_kind', ['request', 'po']);
export const approverType = pgEnum('approver_type', ['hod', 'role']);
export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'changes_requested', 'cancelled']);
export const stepStatus = pgEnum('step_status', ['waiting', 'pending', 'approved', 'rejected', 'changes_requested', 'cancelled']);
export const qcsStatus = pgEnum('qcs_status', ['open', 'reopened', 'converted', 'cancelled']);
export const selectionStatus = pgEnum('selection_status', ['active', 'superseded']);
export const poStatus = pgEnum('po_status', ['pending_approval', 'approved', 'delivered', 'rejected', 'cancelled']);
export const contractStage = pgEnum('contract_stage', [
  'draft', 'review', 'clause_negotiation', 'pending_approval', 'pending_signature', 'signed', 'on_hold', 'cancelled'
]);

// ---------------- organisation & access ----------------
export const orgUnits = pgTable('org_units', {
  id: pk(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: orgUnitType('type').notNull(),
  ownership: ownership('ownership'),
  hodUserId: uuid('hod_user_id').references((): AnyPgColumn => users.id),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (t) => [uniqueIndex('org_units_code_uq').on(sql`lower(${t.code})`)]);

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id),
  googleSub: text('google_sub'),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (t) => [
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  uniqueIndex('users_google_sub_uq').on(t.googleSub),
  check('users_email_lower', sql`${t.email} = lower(${t.email})`)
]);

export const roles = pgTable('roles', {
  id: pk(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  approver: boolean('approver').notNull().default(false)
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull()
}, (t) => [primaryKey({ columns: [t.roleId, t.permission] })]);

export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' })
}, (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)]);

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  ip: text('ip'),
  userAgent: text('user_agent')
}, (t) => [index('sessions_user_idx').on(t.userId)]);

// ---------------- master data ----------------
export const uoms = pgTable('uoms', {
  code: text('code').primaryKey(),
  name: text('name').notNull()
});

export const suppliers = pgTable('suppliers', {
  id: pk(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  category: supplierCategory('category').notNull(),
  contactName: text('contact_name'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  paymentTerms: text('payment_terms'),
  deliveryTerms: text('delivery_terms'),
  leadTimeDays: integer('lead_time_days'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const items = pgTable('items', {
  id: pk(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  category: itemCategory('category').notNull(),
  procurementType: procurementType('procurement_type').notNull(),
  uom: text('uom').notNull().references(() => uoms.code),
  specification: text('specification'),
  brand: text('brand'),
  // Estimated price used when no supplier price exists yet (e.g. generic reference items).
  standardCost: money('standard_cost'),
  isReference: boolean('is_reference').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (t) => [uniqueIndex('items_code_uq').on(sql`lower(${t.code})`)]);

// Supplier prices per item. rank 1 = primary supplier, 2+ = backups. Superseded prices keep
// valid_to set, which gives a price history.
export const itemSupplierPrices = pgTable('item_supplier_prices', {
  id: pk(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  unitPrice: money('unit_price').notNull(),
  currency: text('currency').notNull().default('USD'),
  rank: integer('rank').notNull().default(1),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id)
}, (t) => [
  uniqueIndex('isp_current_uq').on(t.itemId, t.supplierId).where(sql`${t.validTo} is null`),
  index('isp_item_idx').on(t.itemId),
  check('isp_price_nonneg', sql`${t.unitPrice} >= 0`)
]);

// ---------------- requests ----------------
// Request types shown in "+ New Request". Administrators add or retire them; `handling` decides
// which workflow a type follows.
export const requestTypes = pgTable('request_types', {
  id: pk(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  group: requestGroup('group').notNull(),
  handling: requestKind('handling').notNull(),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const requests = pgTable('requests', {
  id: pk(),
  number: text('number').notNull().unique(),
  kind: requestKind('kind').notNull(),
  requestTypeId: uuid('request_type_id').notNull().references(() => requestTypes.id),
  isUrgent: boolean('is_urgent').notNull().default(false),
  urgentReason: text('urgent_reason'),
  // Service requests: who in Procurement is handling it, and the outcome.
  assigneeId: uuid('assignee_id').references(() => users.id),
  resolution: text('resolution'),
  track: track('track').notNull(),
  orgUnitId: uuid('org_unit_id').notNull().references(() => orgUnits.id),
  requesterId: uuid('requester_id').notNull().references(() => users.id),
  status: requestStatus('status').notNull(),
  isPettyCash: boolean('is_petty_cash').notNull().default(false),
  estimatedTotal: money('estimated_total').notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  requiredDate: date('required_date'),
  purpose: text('purpose'),
  referenceUrl: text('reference_url'),
  // Fields specific to a request kind (sample request detail).
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  reconciledBy: uuid('reconciled_by').references(() => users.id),
  reconcileReference: text('reconcile_reference'),
  reconcileAmount: money('reconcile_amount'),
  reconcileNote: text('reconcile_note'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (t) => [
  index('requests_requester_idx').on(t.requesterId),
  index('requests_org_unit_idx').on(t.orgUnitId),
  index('requests_status_idx').on(t.status),
  index('requests_type_idx').on(t.requestTypeId),
  check('requests_petty_cash_purchase', sql`not ${t.isPettyCash} or ${t.kind} = 'purchase'`),
  check('requests_urgent_reason', sql`not ${t.isUrgent} or ${t.urgentReason} is not null`),
  check('requests_petty_cash_not_urgent', sql`not (${t.isPettyCash} and ${t.isUrgent})`)
]);

export const requestLines = pgTable('request_lines', {
  id: pk(),
  requestId: uuid('request_id').notNull().references(() => requests.id),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  uom: text('uom').notNull(),
  estUnitPrice: money('est_unit_price').notNull().default(0),
  status: lineStatus('status').notNull(),
  cancelReason: text('cancel_reason')
}, (t) => [
  uniqueIndex('request_lines_no_uq').on(t.requestId, t.lineNo),
  index('request_lines_status_item_idx').on(t.status, t.itemId),
  check('request_lines_qty_pos', sql`${t.qty} > 0`)
]);

export const comments = pgTable('comments', {
  id: pk(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  createdAt: createdAt()
}, (t) => [index('comments_entity_idx').on(t.entityType, t.entityId)]);

// ---------------- approvals ----------------
export const approvalRules = pgTable('approval_rules', {
  id: pk(),
  documentKind: documentKind('document_kind').notNull(),
  name: text('name').notNull(),
  minAmount: money('min_amount').notNull().default(0),
  maxAmount: money('max_amount'), // exclusive; null = no upper limit
  isPettyCash: boolean('is_petty_cash').notNull().default(false),
  // Optional extra conditions (e.g. {"track":"hq"}); rules with conditions are checked first.
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
  priority: integer('priority').notNull().default(100),
  active: boolean('active').notNull().default(true),
  updatedAt: updatedAt()
}, (t) => [check('approval_rules_range', sql`${t.maxAmount} is null or ${t.maxAmount} > ${t.minAmount}`)]);

export const approvalRuleSteps = pgTable('approval_rule_steps', {
  id: pk(),
  ruleId: uuid('rule_id').notNull().references(() => approvalRules.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  approverType: approverType('approver_type').notNull(),
  roleKey: text('role_key'),
  actionLabel: text('action_label').notNull()
}, (t) => [uniqueIndex('approval_rule_steps_seq_uq').on(t.ruleId, t.seq)]);

export const approvalInstances = pgTable('approval_instances', {
  id: pk(),
  documentKind: documentKind('document_kind').notNull(),
  documentId: uuid('document_id').notNull(),
  ruleId: uuid('rule_id').references(() => approvalRules.id),
  ruleName: text('rule_name').notNull(),
  amount: money('amount').notNull(),
  status: approvalStatus('status').notNull(),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, (t) => [index('approval_instances_doc_idx').on(t.documentKind, t.documentId)]);

export const approvalSteps = pgTable('approval_steps', {
  id: pk(),
  instanceId: uuid('instance_id').notNull().references(() => approvalInstances.id),
  seq: integer('seq').notNull(),
  approverType: approverType('approver_type').notNull(),
  roleKey: text('role_key'),
  // For HOD steps: the org unit whose HOD must act (resolved live, so a new HOD can act).
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id),
  actionLabel: text('action_label').notNull(),
  status: stepStatus('status').notNull(),
  actedBy: uuid('acted_by').references(() => users.id),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  actedAsOverride: boolean('acted_as_override').notNull().default(false),
  comment: text('comment')
}, (t) => [
  uniqueIndex('approval_steps_seq_uq').on(t.instanceId, t.seq),
  index('approval_steps_pending_idx').on(t.status)
]);

// ---------------- sourcing ----------------
export const quoteComparisons = pgTable('quote_comparisons', {
  id: pk(),
  number: text('number').notNull().unique(),
  status: qcsStatus('status').notNull(),
  notes: text('notes'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const qcsItems = pgTable('qcs_items', {
  id: pk(),
  qcsId: uuid('qcs_id').notNull().references(() => quoteComparisons.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  uom: text('uom').notNull()
}, (t) => [uniqueIndex('qcs_items_item_uq').on(t.qcsId, t.itemId), check('qcs_items_qty_pos', sql`${t.qty} > 0`)]);

// Which PR lines were consolidated into a comparison item — the traceability chain.
export const qcsItemLines = pgTable('qcs_item_lines', {
  qcsItemId: uuid('qcs_item_id').notNull().references(() => qcsItems.id),
  requestLineId: uuid('request_line_id').notNull().references(() => requestLines.id)
}, (t) => [primaryKey({ columns: [t.qcsItemId, t.requestLineId] })]);

export const quotations = pgTable('quotations', {
  id: pk(),
  qcsItemId: uuid('qcs_item_id').notNull().references(() => qcsItems.id),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  originalPrice: money('original_price').notNull(),
  unitPrice: money('unit_price').notNull(),
  leadTimeDays: integer('lead_time_days'),
  notes: text('notes'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt()
}, (t) => [
  uniqueIndex('quotations_supplier_uq').on(t.qcsItemId, t.supplierId),
  check('quotations_prices', sql`${t.unitPrice} >= 0 and ${t.originalPrice} >= ${t.unitPrice}`)
]);

// Every winner a person picked, kept forever. When a PO is cancelled the active selection is
// superseded, the comparison reopens, and the next quote is one click away.
export const qcsSelections = pgTable('qcs_selections', {
  id: pk(),
  qcsItemId: uuid('qcs_item_id').notNull().references(() => qcsItems.id),
  quotationId: uuid('quotation_id').notNull().references(() => quotations.id),
  status: selectionStatus('status').notNull(),
  reason: text('reason'),
  selectedBy: uuid('selected_by').notNull().references(() => users.id),
  selectedAt: timestamp('selected_at', { withTimezone: true }).notNull().defaultNow(),
  supersededReason: text('superseded_reason'),
  supersededAt: timestamp('superseded_at', { withTimezone: true })
}, (t) => [uniqueIndex('qcs_selections_active_uq').on(t.qcsItemId).where(sql`${t.status} = 'active'`)]);

// ---------------- purchase orders ----------------
export const purchaseOrders = pgTable('purchase_orders', {
  id: pk(),
  number: text('number').notNull().unique(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  qcsId: uuid('qcs_id').references(() => quoteComparisons.id),
  status: poStatus('status').notNull(),
  total: money('total').notNull(),
  currency: text('currency').notNull().default('USD'),
  expectedDeliveryDate: date('expected_delivery_date'),
  notes: text('notes'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveredBy: uuid('delivered_by').references(() => users.id),
  deliveryNote: text('delivery_note'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  updatedAt: updatedAt()
}, (t) => [index('purchase_orders_status_idx').on(t.status), index('purchase_orders_supplier_idx').on(t.supplierId)]);

export const poLines = pgTable('po_lines', {
  id: pk(),
  poId: uuid('po_id').notNull().references(() => purchaseOrders.id),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  uom: text('uom').notNull(),
  unitPrice: money('unit_price').notNull(),
  // Supplier's asking price before negotiation — the gap is cost avoidance.
  originalPrice: money('original_price').notNull(),
  // Last price paid for this item on an earlier PO — the gap is cost savings.
  priorUnitPrice: money('prior_unit_price'),
  qcsItemId: uuid('qcs_item_id').references(() => qcsItems.id),
  quotationId: uuid('quotation_id').references(() => quotations.id)
}, (t) => [
  uniqueIndex('po_lines_no_uq').on(t.poId, t.lineNo),
  index('po_lines_item_idx').on(t.itemId),
  check('po_lines_qty_pos', sql`${t.qty} > 0`)
]);

// PO line ↔ PR line: which stores' requests this line fulfils (delivery allocation by store).
export const poLineAllocations = pgTable('po_line_allocations', {
  poLineId: uuid('po_line_id').notNull().references(() => poLines.id),
  requestLineId: uuid('request_line_id').notNull().references(() => requestLines.id)
}, (t) => [primaryKey({ columns: [t.poLineId, t.requestLineId] }), index('pla_request_line_idx').on(t.requestLineId)]);

// ---------------- contracts ----------------
// Tracks that a contract exists and its stage/expiry — a pointer to the signed document, never the document.
export const contracts = pgTable('contracts', {
  id: pk(),
  number: text('number').notNull().unique(),
  name: text('name').notNull(),
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  stage: contractStage('stage').notNull(),
  startDate: date('start_date'),
  expiryDate: date('expiry_date'),
  keyTerms: text('key_terms'),
  documentPointer: text('document_pointer'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

// ---------------- cross-cutting ----------------
export const documentSequences = pgTable('document_sequences', {
  prefix: text('prefix').notNull(),
  year: integer('year').notNull(),
  lastValue: integer('last_value').notNull().default(0)
}, (t) => [primaryKey({ columns: [t.prefix, t.year] })]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  comment: text('comment')
}, (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId), index('audit_log_at_idx').on(t.at)]);
