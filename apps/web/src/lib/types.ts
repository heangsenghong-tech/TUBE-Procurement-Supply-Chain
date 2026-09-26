import type { Permission } from '@tube/shared';

export interface Me {
  id: string; email: string; name: string; roles: string[]; permissions: Permission[];
  orgUnit: { id: string; name: string; type: 'store' | 'department' } | null;
  hodUnitIds: string[]; environment: string;
}

export interface OrgUnit { id: string; code: string; name: string; type: 'store' | 'department'; ownership: string | null; active: boolean; hodUserId: string | null; hodName: string | null }

export interface Item {
  id: string; code: string; description: string; category: string; procurementType: string; uom: string; active: boolean; isReference: boolean;
  specification: string | null; brand: string | null; standardCost?: number | null;
  prices?: { id: string; supplierId: string; supplierName: string; supplierCode: string; unitPrice: number; rank: number }[];
}

export interface Supplier {
  id: string; code: string; name: string; category: string; contactName: string | null; phone: string | null; email: string | null;
  address: string | null; paymentTerms: string | null; deliveryTerms: string | null; leadTimeDays: number | null; active: boolean;
}

export interface RequestType {
  id: string; key: string; name: string; group: 'procurement' | 'supply_chain' | 'projects' | 'other';
  handling: 'purchase' | 'sample' | 'service'; description: string; sortOrder: number; active: boolean;
}

export interface RequestSummary {
  id: string; number: string; kind: 'purchase' | 'sample' | 'service'; track: string; status: string; isPettyCash: boolean;
  typeName: string; isUrgent: boolean; subject: string | null;
  orgUnitName: string; requesterName: string; submittedAt: string; lineCount: number; itemName: string | null; estimatedTotal: number | null;
}

export interface ApprovalChain {
  id: string; ruleName: string; status: string; createdAt: string; completedAt: string | null;
  steps: { seq: number; actionLabel: string; status: string; approver: string; actedBy: string | null; actedAt: string | null; override: boolean; comment: string | null }[];
}

export interface RequestDetail {
  id: string; number: string; kind: 'purchase' | 'sample' | 'service'; track: 'store' | 'hq'; status: string; isPettyCash: boolean;
  requestType: { id: string; key: string; name: string };
  isUrgent: boolean; urgentReason: string | null; subject: string | null;
  assignee: { id: string; name: string } | null; resolution: string | null;
  orgUnit: { id: string; name: string; type: string; ownership: 'franchiser' | 'franchisee' | null }; requester: { id: string; name: string };
  estimatedTotal: number | null; requiredDate: string | null; purpose: string | null; referenceUrl: string | null;
  details: Record<string, string | number | undefined>;
  submittedAt: string; completedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  reconciliation: { at: string; by: string | null; receiptReference: string | null; amount: number | null; note: string | null } | null;
  lines: {
    id: string; lineNo: number; itemId: string; itemCode: string; itemDescription: string; qty: number; uom: string; status: string;
    cancelReason: string | null; estUnitPrice: number | null;
    qcs: { id: string; number: string }[]; pos: { id: string; number: string; status: string }[];
  }[];
  approvals: ApprovalChain[];
  comments: { id: string; body: string; createdAt: string; userName: string }[];
  permissions: { canAct: boolean; canCancel: boolean; canResubmit: boolean; canEvaluate: boolean; canReconcile: boolean; canTake: boolean; canResolve: boolean };
}

export interface InboxEntry {
  kind: 'request' | 'po'; documentId: string; number: string; title: string; typeName: string; amount: number | null;
  stepLabel: string; override: boolean; urgent: boolean; submittedAt: string; by: string;
}

export interface ServiceQueueEntry {
  id: string; number: string; status: string; typeName: string; subject: string; orgUnitName: string; requesterName: string;
  assigneeId: string | null; assigneeName: string | null; isUrgent: boolean; urgentReason: string | null; requiredDate: string | null; submittedAt: string; estimatedCost: number;
}

export interface ReviewGroup {
  itemId: string; itemCode: string; itemDescription: string; uom: string; category: string; totalQty: number; estimatedUnitPrice: number; urgent: boolean;
  supplierPrices: { supplierId: string; supplierName: string; unitPrice: number; rank: number }[];
  contributors: { lineId: string; requestId: string; requestNumber: string; unitName: string; track: string; requesterName: string; qty: number; requiredDate: string | null; submittedAt: string; isUrgent: boolean; urgentReason: string | null }[];
}

export interface Qcs {
  id: string; number: string; status: string; notes: string | null; createdAt: string; createdBy: string; prNumbers: string[];
  items: {
    id: string; itemId: string; itemCode: string; itemDescription: string; qty: number; uom: string; hasLivePo: boolean;
    quotes: { id: string; supplierId: string; supplierName: string; unitPrice: number; originalPrice: number; leadTimeDays: number | null; notes: string | null; selected: boolean; failedBefore: boolean }[];
    selectionHistory: { quotationId: string; status: string; by: string; at: string; reason: string | null; supersededReason: string | null }[];
    contributors: { lineId: string; qty: number; status: string; number: string; unitName: string }[];
    pos: { id: string; number: string; status: string; quotationId: string | null }[];
  }[];
}

export interface PoSummary { id: string; number: string; status: string; supplierName: string; qcsNumber: string | null; total: number | null; createdAt: string; expectedDeliveryDate: string | null; deliveredAt: string | null }

export interface PoDetail {
  id: string; number: string; status: string; total: number | null; currency: string;
  supplier: { id: string; name: string; code: string; phone: string | null; contactName: string | null; paymentTerms: string | null };
  qcs: { id: string; number: string } | null; prNumbers: string[];
  createdAt: string; createdBy: string; expectedDeliveryDate: string | null; notes: string | null;
  approvedAt: string | null; deliveredAt: string | null; deliveryNote: string | null; cancelledAt: string | null; cancelReason: string | null;
  lines: {
    id: string; lineNo: number; itemCode: string; itemDescription: string; qty: number; uom: string;
    unitPrice: number | null; amount: number | null; originalPrice: number | null; priorUnitPrice: number | null;
    savings: number | null; avoidance: number | null;
    allocation: { qty: number; number: string; requestId: string; unitName: string }[];
  }[];
  approvals: ApprovalChain[];
  totals: { savings: number; avoidance: number } | null;
  permissions: { canAct: boolean; canCancel: boolean; canDeliver: boolean };
}

export interface Contract {
  id: string; number: string; name: string; supplierId: string | null; supplierName: string | null; stage: string;
  startDate: string | null; expiryDate: string | null; keyTerms: string | null; documentPointer: string | null;
}

export interface UserRow { id: string; email: string; name: string; orgUnitId: string | null; orgUnitName: string | null; active: boolean; lastLoginAt: string | null; roleKeys: string[] }
export interface Role { id: string; key: string; name: string; description: string; approver: boolean; permissions: string[] }

export interface ApprovalRule {
  id: string; documentKind: 'request' | 'po'; name: string; minAmount: number; maxAmount: number | null; isPettyCash: boolean; active: boolean;
  priority: number; conditions: import('@tube/shared').ApprovalConditions;
  steps: { id: string; seq: number; approverType: 'hod' | 'role'; roleKey: string | null; actionLabel: string }[];
}

export interface Spend {
  period: string; from: string; to: string; storeSpend: number; hqSpend: number;
  byUnit: { name: string; amount: number }[]; byItem: { name: string; amount: number }[]; bySupplier: { name: string; amount: number }[] | null;
}
