// Permission keys. The server checks these on every request; the UI only uses them
// to decide what to show. Roles are bundles of permissions and are configurable in
// the database — these defaults are what a fresh installation is seeded with.

export const PERMISSIONS = {
  'request.create': 'Create requests (PRs, sample requests)',
  'request.view_all': 'See every request, not just your own and your unit\'s',
  'pricing.view': 'See item prices, estimated values and PO amounts',
  'supplier.view': 'See supplier identities and contact details',
  'procurement.operate': 'Review & consolidate, quote comparisons, generate and manage POs',
  'po.view': 'See purchase orders',
  'contract.view': 'See the contract register',
  'contract.manage': 'Add and update contracts',
  'master.manage': 'Maintain items, suppliers, stores and departments',
  'spend.view': 'See spend dashboards by store, department and item',
  'spend.supplier.view': 'See spend broken down by supplier',
  'export.sensitive': 'Download or print the Price List, Quote Comparisons and Contracts',
  'pettycash.view': 'See the petty cash register',
  'pettycash.reconcile': 'Mark petty cash PRs reconciled against the physical invoice',
  'approval.override': 'Act on an approval step when its assigned approver is missing',
  'settings.manage': 'Change approval rules',
  'users.manage': 'Add users and assign roles, stores and departments',
  'audit.view': 'See the activity log'
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  // Roles an approval step can be assigned to.
  approver?: boolean;
}

const REQUESTER: Permission[] = ['request.create'];

const PROCUREMENT: Permission[] = [
  ...REQUESTER, 'request.view_all', 'pricing.view', 'supplier.view', 'procurement.operate',
  'po.view', 'contract.view', 'contract.manage', 'master.manage', 'spend.view', 'spend.supplier.view'
];

export const DEFAULT_ROLES: RoleDefinition[] = [
  { key: 'super_admin', name: 'Super Admin', description: 'Full access, including users and settings.', permissions: [...ALL_PERMISSIONS] },
  { key: 'ceo', name: 'CEO', approver: true, description: 'Executive visibility and final approval.',
    permissions: [...REQUESTER, 'request.view_all', 'pricing.view', 'supplier.view', 'po.view', 'contract.view', 'spend.view', 'spend.supplier.view', 'pettycash.view', 'audit.view'] },
  { key: 'supply_chain_manager', name: 'Supply Chain Manager', approver: true, description: 'Full Procurement & Supply Chain control.',
    permissions: [...PROCUREMENT, 'pettycash.view', 'approval.override', 'settings.manage', 'audit.view'] },
  { key: 'head_of_operation', name: 'Head of Operation', approver: true, description: 'Reviews every store (Track B) request of $100 or more.',
    permissions: [...REQUESTER, 'request.view_all', 'pricing.view'] },
  { key: 'procurement_officer', name: 'Procurement Officer', description: 'Day-to-day sourcing and purchase orders.', permissions: [...PROCUREMENT] },
  { key: 'finance_head', name: 'Head of Finance / Accounting Manager', approver: true, description: 'Approves PRs and POs; reconciles petty cash.',
    permissions: [...REQUESTER, 'request.view_all', 'pricing.view', 'supplier.view', 'po.view', 'contract.view', 'spend.view', 'spend.supplier.view', 'pettycash.view', 'pettycash.reconcile'] },
  { key: 'finance', name: 'Finance', description: 'Financial verification and petty cash reconciliation.',
    permissions: [...REQUESTER, 'request.view_all', 'pricing.view', 'supplier.view', 'po.view', 'spend.view', 'spend.supplier.view', 'pettycash.view', 'pettycash.reconcile'] },
  { key: 'warehouse', name: 'Warehouse', description: 'Receiving (full warehouse module comes in a later phase).', permissions: [...REQUESTER, 'po.view', 'supplier.view'] },
  { key: 'requester', name: 'Store / Department User', description: 'Creates and tracks their own requests.', permissions: [...REQUESTER] },
  { key: 'export_authorized', name: 'Export Authorization', description: 'Narrower than viewing: allows downloading/printing sensitive lists.', permissions: ['export.sensitive'] }
];
