import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { db, sql };
}

export type Db = ReturnType<typeof createDb>['db'];
// A transaction handle has the same query API as the database.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
