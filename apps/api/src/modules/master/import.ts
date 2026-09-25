// CSV imports. Every row is validated first; if any row has a problem nothing is written and
// each problem is reported with its row number. Existing codes/emails are updated, new ones added.
import { itemInput, orgUnitInput, supplierInput, userInput } from '@tube/shared';
import type { Db } from '../../db/client';
import * as t from '../../db/schema';
import { type Actor, requirePermission } from '../../core/actor';
import { audit } from '../../core/audit';
import { badRequest } from '../../core/errors';
import { normaliseUom } from '../../db/seed/reference';
import { setItemPrice, upsertItem, upsertOrgUnit, upsertSupplier, upsertUser } from './service';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function toRecords(text: string, required: string[]) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw badRequest('The file has no data rows.');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const missing = required.filter((r) => !header.includes(r.toLowerCase()));
  if (missing.length) throw badRequest(`Missing column(s): ${missing.join(', ')}. First row must be the headers.`);
  if (rows.length > 5001) throw badRequest('Import at most 5,000 rows at a time.');
  return rows.slice(1).map((r, i) => ({
    rowNo: i + 2,
    get: (name: string) => (r[header.indexOf(name.toLowerCase())] ?? '').trim()
  }));
}

export interface ImportResult { created: number; updated: number; errors: { row: number; message: string }[] }

function issues(e: { issues: { path: PropertyKey[]; message: string }[] }) {
  return e.issues.map((i) => (i.path.length ? `${String(i.path[0])}: ` : '') + i.message).join('; ');
}

// Item Code, Description, Category, Type, UOM, Unit Price, Supplier — the prototype's price-list format.
export async function importItems(db: Db, actor: Actor, text: string, dryRun: boolean): Promise<ImportResult> {
  requirePermission(actor, 'master.manage');
  const recs = toRecords(text, ['Item Code', 'Description', 'Category', 'Type', 'UOM']);
  const suppliers = await db.select().from(t.suppliers);
  const existing = await db.select({ id: t.items.id, code: t.items.code }).from(t.items);
  const errors: ImportResult['errors'] = [];
  const valid: { id: string | null; input: ReturnType<typeof itemInput.parse>; price?: number; supplierId?: string }[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    let uom = r.get('UOM');
    try { uom = normaliseUom(uom); } catch (e) { errors.push({ row: r.rowNo, message: (e as Error).message }); continue; }
    const priceText = r.get('Unit Price');
    const price = priceText === '' ? undefined : Number(priceText);
    const parsed = itemInput.safeParse({
      code: r.get('Item Code'), description: r.get('Description'), category: r.get('Category'), procurementType: r.get('Type'), uom,
      standardCost: price
    });
    if (!parsed.success) { errors.push({ row: r.rowNo, message: issues(parsed.error) }); continue; }
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) { errors.push({ row: r.rowNo, message: 'Unit Price must be a number' }); continue; }
    const key = parsed.data.code.toLowerCase();
    if (seen.has(key)) { errors.push({ row: r.rowNo, message: `Item code ${parsed.data.code} appears twice in the file` }); continue; }
    seen.add(key);
    const supplierName = r.get('Supplier');
    let supplierId: string | undefined;
    if (supplierName) {
      const s = suppliers.find((x) => x.name.toLowerCase() === supplierName.toLowerCase() || x.code.toLowerCase() === supplierName.toLowerCase());
      if (!s) { errors.push({ row: r.rowNo, message: `Unknown supplier "${supplierName}" — add it first` }); continue; }
      supplierId = s.id;
    }
    valid.push({ id: existing.find((x) => x.code.toLowerCase() === key)?.id ?? null, input: parsed.data, price, supplierId });
  }
  const result = { created: valid.filter((v) => !v.id).length, updated: valid.filter((v) => v.id).length, errors };
  if (errors.length || dryRun) return result;
  for (const v of valid) {
    const { id } = await upsertItem(db, actor, v.id, v.input);
    if (v.supplierId && v.price !== undefined) await setItemPrice(db, actor, id, { supplierId: v.supplierId, unitPrice: v.price, rank: 1 });
  }
  await audit(db, { userId: actor.id, action: 'import.items', after: { created: result.created, updated: result.updated } });
  return result;
}

// Code, Name, Category, Contact Name, Phone, Email, Address, Payment Terms, Delivery Terms, Lead Time Days
export async function importSuppliers(db: Db, actor: Actor, text: string, dryRun: boolean): Promise<ImportResult> {
  requirePermission(actor, 'master.manage');
  const recs = toRecords(text, ['Name', 'Category']);
  const existing = await db.select({ id: t.suppliers.id, code: t.suppliers.code, name: t.suppliers.name }).from(t.suppliers);
  const errors: ImportResult['errors'] = [];
  const valid: { id: string | null; input: ReturnType<typeof supplierInput.parse> }[] = [];
  for (const r of recs) {
    const lead = r.get('Lead Time Days');
    const parsed = supplierInput.safeParse({
      name: r.get('Name'), category: r.get('Category'), contactName: r.get('Contact Name'), phone: r.get('Phone') || r.get('Contact'),
      email: r.get('Email'), address: r.get('Address'), paymentTerms: r.get('Payment Terms') || r.get('Payment Term'),
      deliveryTerms: r.get('Delivery Terms'), leadTimeDays: lead ? Number(lead) : undefined
    });
    if (!parsed.success) { errors.push({ row: r.rowNo, message: issues(parsed.error) }); continue; }
    const code = r.get('Code');
    const match = code ? existing.find((x) => x.code.toLowerCase() === code.toLowerCase())
      : existing.find((x) => x.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (code && !match) { errors.push({ row: r.rowNo, message: `No supplier with code ${code} — leave Code empty to add a new one` }); continue; }
    valid.push({ id: match?.id ?? null, input: parsed.data });
  }
  const result = { created: valid.filter((v) => !v.id).length, updated: valid.filter((v) => v.id).length, errors };
  if (errors.length || dryRun) return result;
  for (const v of valid) await upsertSupplier(db, actor, v.id, v.input);
  await audit(db, { userId: actor.id, action: 'import.suppliers', after: { created: result.created, updated: result.updated } });
  return result;
}

// Code, Name, Type (store/department), Ownership (franchiser/franchisee), HOD Email
export async function importOrgUnits(db: Db, actor: Actor, text: string, dryRun: boolean): Promise<ImportResult> {
  requirePermission(actor, 'master.manage');
  const recs = toRecords(text, ['Code', 'Name', 'Type']);
  const units = await db.select().from(t.orgUnits);
  const users = await db.select({ id: t.users.id, email: t.users.email }).from(t.users);
  const errors: ImportResult['errors'] = [];
  const valid: { id: string | null; input: ReturnType<typeof orgUnitInput.parse> }[] = [];
  for (const r of recs) {
    const hodEmail = r.get('HOD Email').toLowerCase();
    const hod = hodEmail ? users.find((u) => u.email === hodEmail) : undefined;
    if (hodEmail && !hod) { errors.push({ row: r.rowNo, message: `No user with email ${hodEmail} — import users first, then set HODs` }); continue; }
    const parsed = orgUnitInput.safeParse({
      code: r.get('Code'), name: r.get('Name'), type: r.get('Type').toLowerCase(),
      ownership: r.get('Ownership').toLowerCase() || undefined, hodUserId: hod?.id ?? null
    });
    if (!parsed.success) { errors.push({ row: r.rowNo, message: issues(parsed.error) }); continue; }
    valid.push({ id: units.find((u) => u.code.toLowerCase() === parsed.data.code.toLowerCase())?.id ?? null, input: parsed.data });
  }
  const result = { created: valid.filter((v) => !v.id).length, updated: valid.filter((v) => v.id).length, errors };
  if (errors.length || dryRun) return result;
  for (const v of valid) await upsertOrgUnit(db, actor, v.id, v.input);
  return result;
}

// Email, Name, Store/Department Code, Roles (separated by ;)
export async function importUsers(db: Db, actor: Actor, text: string, dryRun: boolean): Promise<ImportResult> {
  requirePermission(actor, 'users.manage');
  const recs = toRecords(text, ['Email', 'Name']);
  const units = await db.select().from(t.orgUnits);
  const roles = await db.select().from(t.roles);
  const existing = await db.select({ id: t.users.id, email: t.users.email }).from(t.users);
  const errors: ImportResult['errors'] = [];
  const valid: { id: string | null; input: ReturnType<typeof userInput.parse> }[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const unitCode = r.get('Store/Department Code') || r.get('Unit Code');
    const unit = unitCode ? units.find((u) => u.code.toLowerCase() === unitCode.toLowerCase()) : undefined;
    if (unitCode && !unit) { errors.push({ row: r.rowNo, message: `Unknown store/department code ${unitCode}` }); continue; }
    const roleKeys = (r.get('Roles') || 'requester').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const badRole = roleKeys.find((k) => !roles.some((x) => x.key === k));
    if (badRole) { errors.push({ row: r.rowNo, message: `Unknown role "${badRole}". Use: ${roles.map((x) => x.key).join(', ')}` }); continue; }
    const parsed = userInput.safeParse({ email: r.get('Email'), name: r.get('Name'), orgUnitId: unit?.id ?? null, roleKeys });
    if (!parsed.success) { errors.push({ row: r.rowNo, message: issues(parsed.error) }); continue; }
    if (seen.has(parsed.data.email)) { errors.push({ row: r.rowNo, message: `${parsed.data.email} appears twice in the file` }); continue; }
    seen.add(parsed.data.email);
    valid.push({ id: existing.find((u) => u.email === parsed.data.email)?.id ?? null, input: parsed.data });
  }
  const result = { created: valid.filter((v) => !v.id).length, updated: valid.filter((v) => v.id).length, errors };
  if (errors.length || dryRun) return result;
  for (const v of valid) await upsertUser(db, actor, v.id, v.input);
  return result;
}

export const IMPORT_TEMPLATES: Record<string, string> = {
  items: 'Item Code,Description,Category,Type,UOM,Unit Price,Supplier\r\nI00100,Example Item,Food,Direct,Kg,10.50,Kofi\r\n',
  suppliers: 'Code,Name,Category,Contact Name,Phone,Email,Address,Payment Terms,Delivery Terms,Lead Time Days\r\n,Example Supplier Co.,Food,Ms. Example,012 345 678,sales@example.com,Phnom Penh,1 MONTH,Delivered to store,3\r\n',
  'org-units': 'Code,Name,Type,Ownership,HOD Email\r\nTK,Toul Kork,store,franchisee,\r\n',
  users: 'Email,Name,Store/Department Code,Roles\r\nsomeone@tubecafecambodia.com,Someone,TK,requester\r\n'
};

