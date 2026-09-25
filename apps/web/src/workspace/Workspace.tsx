import type { Permission } from '@tube/shared';
import { Link, useParams } from 'react-router';
import { useCan } from '../lib/ui';
import { ReviewPanel } from './Review';
import { QcsListPanel } from './QcsList';
import { PoListPanel } from './PoList';
import { MonthlySummaryPanel } from './MonthlySummary';
import { PriceListPanel } from './PriceList';
import { MasterDataPanel } from './MasterData';
import { ContractsPanel } from './Contracts';
import { PettyCashPanel } from './PettyCash';
import { ApprovalRulesPanel } from './ApprovalRules';
import { PeoplePanel } from './People';
import { AuditPanel } from './Audit';

interface Tile { key: string; icon: string; label: string; desc: string; tone: string; perm: Permission; anyOf?: Permission[]; Panel: () => React.JSX.Element }

const TILES: Tile[] = [
  { key: 'review', icon: '📋', label: 'Review & Consolidate', desc: 'Group requests by item, adjust qty', tone: 'c-yellow', perm: 'procurement.operate', Panel: ReviewPanel },
  { key: 'qcs', icon: '📊', label: 'Quote Comparison', desc: 'Compare suppliers, pick a winner', tone: 'c-blue', perm: 'procurement.operate', Panel: QcsListPanel },
  { key: 'pos', icon: '📄', label: 'Purchase Orders', desc: 'Approve, print, deliver', tone: 'c-green', perm: 'po.view', Panel: PoListPanel },
  { key: 'monthly', icon: '📈', label: 'Monthly Summary', desc: 'Leadership reporting, savings', tone: 'c-rose', perm: 'spend.view', Panel: MonthlySummaryPanel },
  { key: 'price-list', icon: '💰', label: 'Price List', desc: 'Every item, by supplier', tone: 'c-yellow', perm: 'pricing.view', Panel: PriceListPanel },
  { key: 'master', icon: '🗂️', label: 'Item & Supplier Master', desc: 'Add, edit, bulk upload', tone: 'c-blue', perm: 'master.manage', Panel: MasterDataPanel },
  { key: 'contracts', icon: '📑', label: 'Contracts', desc: 'Expiry tracking, not documents', tone: 'c-rose', perm: 'contract.view', Panel: ContractsPanel },
  { key: 'petty-cash', icon: '🧾', label: 'Petty Cash', desc: 'Match to physical invoices', tone: 'c-green', perm: 'pettycash.view', Panel: PettyCashPanel },
  { key: 'rules', icon: '🔑', label: 'Approval Rules', desc: 'Who approves what, from how much', tone: 'c-green', perm: 'settings.manage', Panel: ApprovalRulesPanel },
  { key: 'people', icon: '👥', label: 'Users & Stores', desc: 'Accounts, roles, HODs', tone: 'c-yellow', perm: 'users.manage', anyOf: ['users.manage', 'master.manage'], Panel: PeoplePanel },
  { key: 'audit', icon: '🕘', label: 'Activity Log', desc: 'Who did what, when', tone: 'c-blue', perm: 'audit.view', Panel: AuditPanel }
];

export function WorkspacePage() {
  const { panel } = useParams();
  const can = useCan();
  const tiles = TILES.filter((t) => (t.anyOf ?? [t.perm]).some((p) => can(p)));
  const active = tiles.find((t) => t.key === panel);
  if (!tiles.length) return <div className="card"><div className="banner">You don't have access to the Procurement Workspace.</div></div>;
  return (
    <>
      <div className="ws-tiles no-print">
        {tiles.map((t) => (
          <Link key={t.key} to={`/workspace/${t.key}`} className={`ws-tile statcard ${t.tone}${t.key === panel ? ' active' : ''}`}>
            <span className="ws-icon">{t.icon}</span><span className="ws-label">{t.label}</span><span className="ws-desc">{t.desc}</span>
          </Link>
        ))}
      </div>
      {active ? <active.Panel /> : <div className="sub">Pick a tile above to open it here.</div>}
    </>
  );
}
