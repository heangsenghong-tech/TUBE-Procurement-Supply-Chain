import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { seedReference } from '../src/db/seed/reference';
import * as t from '../src/db/schema';
import { type Actor, loadActor } from '../src/core/actor';
import * as master from '../src/modules/master/service';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tube:tube@localhost:5432/tube_test';
const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.resolve(here, '../../../data/seed');

export async function freshDatabase() {
  const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await admin.end();
  await runMigrations(TEST_DB_URL);
  const { db, sql } = createDb(TEST_DB_URL);
  await seedReference(db, { seedDir: SEED_DIR, adminEmail: 'admin@tubecafecambodia.com', adminName: 'Admin' });
  return { db, sql };
}

export interface World {
  db: Db;
  admin: Actor;
  units: Record<string, string>;
  people: Record<string, Actor>;
  item: (code: string) => Promise<string>;
  supplier: (code: string) => Promise<string>;
  as: (key: string) => Promise<Actor>;
}

// A small company: two stores with HODs (Track B), HR with a HOD and Marketing without one
// (Track A), the Head of Operation, and one person per approver role.
export async function buildWorld(db: Db): Promise<World> {
  const adminUser = (await db.query.users.findFirst({ where: eq(t.users.email, 'admin@tubecafecambodia.com') }))!;
  const admin = (await loadActor(db, adminUser.id))!;
  await master.upsertOrgUnit(db, admin, null, { code: 'TK', name: 'Toul Kork', type: 'store', ownership: 'franchisee' });
  const units: Record<string, string> = {};
  for (const u of await master.listOrgUnits(db)) units[u.code] = u.id;

  const spec: [string, string, string[]][] = [
    ['kdt.hod', 'KDT', ['requester']], ['kdt.staff', 'KDT', ['requester']], ['tk.hod', 'TK', ['requester']], ['tk.staff', 'TK', ['requester']],
    ['mkt.staff', 'MKT', ['requester']], ['hr.hod', 'HR', ['requester']], ['hr.staff', 'HR', ['requester']],
    ['ops.head', 'OPS', ['requester', 'head_of_operation']], ['finhead', 'FIN', ['finance_head']], ['finance', 'FIN', ['finance']], ['ceo', 'MGT', ['ceo']],
    ['scm', 'SCP', ['supply_chain_manager']], ['buyer', 'SCP', ['procurement_officer']], ['buyer.export', 'SCP', ['procurement_officer', 'export_authorized']]
  ];
  const ids: Record<string, string> = {};
  for (const [key, unit, roles] of spec) {
    ids[key] = (await master.upsertUser(db, admin, null, { email: `${key}@tubecafecambodia.com`, name: key, orgUnitId: units[unit], roleKeys: roles })).id;
  }
  await master.upsertOrgUnit(db, admin, units.KDT!, { code: 'KDT', name: 'KDT', type: 'store', ownership: 'franchiser', hodUserId: ids['kdt.hod'] });
  await master.upsertOrgUnit(db, admin, units.TK!, { code: 'TK', name: 'Toul Kork', type: 'store', ownership: 'franchisee', hodUserId: ids['tk.hod'] });
  await master.upsertOrgUnit(db, admin, units.HR!, { code: 'HR', name: 'HR', type: 'department', hodUserId: ids['hr.hod'] });

  const as = async (key: string) => (await loadActor(db, ids[key]!))!;
  const people: Record<string, Actor> = {};
  for (const k of Object.keys(ids)) people[k] = await as(k);
  return {
    db, admin: (await loadActor(db, adminUser.id))!, units, people, as,
    item: async (code) => (await db.query.items.findFirst({ where: eq(t.items.code, code) }))!.id,
    supplier: async (code) => (await db.query.suppliers.findFirst({ where: eq(t.suppliers.code, code) }))!.id
  };
}
