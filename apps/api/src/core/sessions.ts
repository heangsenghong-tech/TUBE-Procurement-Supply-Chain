import crypto from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import * as t from '../db/schema';

export const SESSION_COOKIE = 'tube_session';
export const SESSION_DAYS = 14;

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: string, meta: { ip?: string; userAgent?: string }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.delete(t.sessions).where(lte(t.sessions.expiresAt, new Date()));
  await db.insert(t.sessions).values({
    tokenHash: hash(token), userId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5),
    ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null
  });
  return token;
}

export async function userIdForSession(db: Db, token: string | undefined) {
  if (!token) return null;
  const row = await db.query.sessions.findFirst({
    where: and(eq(t.sessions.tokenHash, hash(token)), gt(t.sessions.expiresAt, new Date()))
  });
  return row?.userId ?? null;
}

export async function deleteSession(db: Db, token: string | undefined) {
  if (token) await db.delete(t.sessions).where(eq(t.sessions.tokenHash, hash(token)));
}

export async function deleteUserSessions(db: DbOrTx, userId: string) {
  await db.delete(t.sessions).where(eq(t.sessions.userId, userId));
}
