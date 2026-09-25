import type { DbOrTx } from '../db/client';
import * as t from '../db/schema';

export async function audit(db: DbOrTx, entry: {
  userId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  comment?: string | null;
}) {
  await db.insert(t.auditLog).values({
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    comment: entry.comment ?? null
  });
}
