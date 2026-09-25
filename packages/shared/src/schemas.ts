// Input validation shared by the API (enforced) and the web app (early feedback).
import { z } from 'zod';
import { CONTRACT_STAGES, SAMPLE_EVALUATION_STATUSES } from './statuses';

const id = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).transform((v) => (v ? v : undefined)).optional();
const quantity = z.number().positive().max(1_000_000).multipleOf(0.001);
const money = z.number().min(0).max(100_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const httpUrl = z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link')
  .optional().or(z.literal('').transform(() => undefined));

export const trackSchema = z.enum(['store', 'hq']);

export const purchaseRequestInput = z.object({
  track: trackSchema,
  orgUnitId: id,
  requiredDate: isoDate.optional(),
  purpose: optionalText(500),
  referenceUrl: httpUrl,
  lines: z.array(z.object({ itemId: id, qty: quantity })).min(1, 'Add at least one item').max(60)
}).refine((v) => new Set(v.lines.map((l) => l.itemId)).size === v.lines.length, { message: 'Each item may appear only once — combine the quantities', path: ['lines'] });
export type PurchaseRequestInput = z.infer<typeof purchaseRequestInput>;

export const sampleRequestInput = z.object({
  track: trackSchema,
  orgUnitId: id,
  itemName: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  timeline: optionalText(200),
  quantity: z.number().int().positive().max(1_000_000),
  placeOfUsage: optionalText(200),
  size: optionalText(100),
  material: optionalText(100),
  colorCode: optionalText(100),
  referenceUrl: httpUrl
});
export type SampleRequestInput = z.infer<typeof sampleRequestInput>;

export const sampleEvaluationInput = z.object({
  status: z.enum(SAMPLE_EVALUATION_STATUSES),
  comment: optionalText(1000)
});

export const approvalActionInput = z.object({
  action: z.enum(['approve', 'reject', 'request_changes']),
  comment: optionalText(1000)
}).refine((v) => v.action === 'approve' || !!v.comment, { message: 'Please give a reason', path: ['comment'] });
export type ApprovalActionInput = z.infer<typeof approvalActionInput>;

export const cancelInput = z.object({ reason: z.string().trim().min(1, 'Please give a reason').max(500) });

export const commentInput = z.object({ body: z.string().trim().min(1).max(2000) });

export const pettyCashReconcileInput = z.object({
  receiptReference: z.string().trim().min(1, 'Enter the invoice/receipt number').max(100),
  actualAmount: money.optional(),
  note: optionalText(500)
});

// ---- procurement ----
const lineGroup = z.object({
  itemId: id,
  qty: quantity,
  requestLineIds: z.array(id).min(1)
});

export const createQcsInput = z.object({
  groups: z.array(lineGroup).min(1).max(50),
  notes: optionalText(500)
});

export const quotationInput = z.object({
  supplierId: id,
  unitPrice: money,
  originalPrice: money.optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  notes: optionalText(300)
}).refine((v) => v.originalPrice == null || v.originalPrice >= v.unitPrice, { message: 'Original price can\'t be lower than the negotiated price', path: ['originalPrice'] });

export const selectQuotationInput = z.object({ quotationId: id, reason: optionalText(300) });

export const generatePoFromQcsInput = z.object({
  expectedDeliveryDate: isoDate.optional(),
  notes: optionalText(500)
});

export const directPoInput = z.object({
  supplierId: id,
  expectedDeliveryDate: isoDate.optional(),
  notes: optionalText(500),
  lines: z.array(lineGroup.extend({ unitPrice: money })).min(1).max(60)
});
export type DirectPoInput = z.infer<typeof directPoInput>;

export const deliverPoInput = z.object({ note: optionalText(500) });

// ---- master data ----
export const itemInput = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_\-.]+$/, 'Letters, digits, - _ . only'),
  description: z.string().trim().min(1).max(200),
  category: z.enum(['Food', 'Non-food']),
  procurementType: z.enum(['Direct', 'Indirect']),
  uom: z.string().trim().min(1).max(20),
  specification: optionalText(500),
  brand: optionalText(100),
  standardCost: money.optional(),
  isReference: z.boolean().optional(),
  active: z.boolean().optional()
});
export type ItemInput = z.infer<typeof itemInput>;

export const itemPriceInput = z.object({
  supplierId: id,
  unitPrice: money,
  rank: z.number().int().min(1).max(9)
});

export const supplierInput = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(['Food', 'Non-food', 'Both']),
  contactName: optionalText(120),
  phone: optionalText(60),
  email: z.string().trim().max(200).email().optional().or(z.literal('').transform(() => undefined)),
  address: optionalText(300),
  paymentTerms: optionalText(100),
  deliveryTerms: optionalText(100),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional()
});
export type SupplierInput = z.infer<typeof supplierInput>;

export const orgUnitInput = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['store', 'department']),
  ownership: z.enum(['franchiser', 'franchisee']).optional(),
  hodUserId: id.nullable().optional(),
  active: z.boolean().optional()
});

export const userInput = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  orgUnitId: id.nullable().optional(),
  roleKeys: z.array(z.string()).max(20),
  active: z.boolean().optional()
});

export const contractInput = z.object({
  name: z.string().trim().min(1).max(200),
  supplierId: id.optional(),
  stage: z.enum(Object.keys(CONTRACT_STAGES) as [keyof typeof CONTRACT_STAGES]),
  startDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  keyTerms: optionalText(1000),
  documentPointer: optionalText(500)
});

export const approvalRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  minAmount: money,
  maxAmount: money.nullable(),
  isPettyCash: z.boolean(),
  active: z.boolean(),
  steps: z.array(z.object({
    approverType: z.enum(['hod', 'role']),
    roleKey: z.string().optional(),
    actionLabel: z.string().trim().min(1).max(60)
  }).refine((s) => s.approverType === 'hod' || !!s.roleKey, { message: 'Pick a role', path: ['roleKey'] })).max(6)
}).refine((r) => r.maxAmount == null || r.maxAmount > r.minAmount, { message: 'Upper limit must be above the lower limit', path: ['maxAmount'] });
