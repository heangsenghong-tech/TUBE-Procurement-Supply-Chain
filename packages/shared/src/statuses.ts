// Status values and the plain-language labels shown to people.

export const REQUEST_STATUSES = {
  pending_approval: 'Awaiting approval',
  changes_requested: 'Changes requested',
  approved: 'Approved — with Procurement',
  in_progress: 'Procurement in progress',
  ordered: 'Ordered',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  petty_cash_approved: 'Petty cash — acknowledged by HOD',
  petty_cash_reconciled: 'Petty cash — reconciled by Finance',
  // Sample request evaluation loop
  sourcing: 'Sourcing sample',
  under_review: 'Under Review',
  under_evaluation: 'Under Evaluation',
  under_consideration: 'Under Consideration',
  pass: 'Pass',
  fail: 'Fail',
  not_meet_requirement: 'Not Meet Requirement'
} as const;
export type RequestStatus = keyof typeof REQUEST_STATUSES;

export const SAMPLE_EVALUATION_STATUSES = [
  'under_review', 'under_evaluation', 'under_consideration', 'pass', 'fail', 'not_meet_requirement'
] as const satisfies readonly RequestStatus[];
export type SampleEvaluationStatus = (typeof SAMPLE_EVALUATION_STATUSES)[number];

export const LINE_STATUSES = {
  pending_approval: 'Awaiting approval',
  open: 'Waiting for Procurement',
  in_qcs: 'Quote comparison',
  ordered: 'Ordered',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  petty_cash: 'Petty cash'
} as const;
export type LineStatus = keyof typeof LINE_STATUSES;

export const QCS_STATUSES = {
  open: 'Collecting quotes',
  reopened: 'Reopened — pick another supplier',
  converted: 'PO generated',
  cancelled: 'Cancelled'
} as const;
export type QcsStatus = keyof typeof QCS_STATUSES;

export const PO_STATUSES = {
  pending_approval: 'Awaiting approval',
  approved: 'Approved — awaiting delivery',
  delivered: 'Delivered',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
} as const;
export type PoStatus = keyof typeof PO_STATUSES;

export const CONTRACT_STAGES = {
  draft: 'Draft',
  review: 'Under Review',
  clause_negotiation: 'Clause Negotiation',
  pending_approval: 'Pending Internal Approval (CEO/Finance)',
  pending_signature: 'Pending Supplier Signature',
  signed: 'Signed',
  on_hold: 'On Hold',
  cancelled: 'Cancelled'
} as const;
export type ContractStage = keyof typeof CONTRACT_STAGES;

export const APPROVAL_STEP_STATUSES = {
  waiting: 'Waiting',
  pending: 'Pending',
  approved: 'Done',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
  cancelled: 'Cancelled'
} as const;
export type ApprovalStepStatus = keyof typeof APPROVAL_STEP_STATUSES;

export const TRACKS = { store: 'Store', hq: 'HQ department' } as const;
export type Track = keyof typeof TRACKS;
