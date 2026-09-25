// The signed-in person, with everything authorization needs, loaded fresh on every request
// so role or HOD changes take effect immediately.
import { and, eq, inArray } from 'drizzle-orm';
import type { Permission } from '@tube/shared';
import type { DbOrTx } from '../db/client';
import * as t from '../db/schema';
import { forbidden } from './errors';

export interface Actor {
  id: string;
  email: string;
  name: string;
  orgUnitId: string | null;
  roles: Set<string>;
  permissions: Set<Permission>;
  // Org units where this person is the Head of Department.
  hodUnitIds: string[];
}

export async function loadActor(db: DbOrTx, userId: string): Promise<Actor | null> {
  const user = await db.query.users.findFirst({ where: and(eq(t.users.id, userId), eq(t.users.active, true)) });
  if (!user) return null;
  const roleRows = await db.select({ key: t.roles.key, id: t.roles.id })
    .from(t.userRoles).innerJoin(t.roles, eq(t.roles.id, t.userRoles.roleId))
    .where(eq(t.userRoles.userId, userId));
  const perms = roleRows.length
    ? await db.select({ p: t.rolePermissions.permission }).from(t.rolePermissions)
      .where(inArray(t.rolePermissions.roleId, roleRows.map((r) => r.id)))
    : [];
  const hodUnits = await db.select({ id: t.orgUnits.id }).from(t.orgUnits)
    .where(and(eq(t.orgUnits.hodUserId, userId), eq(t.orgUnits.active, true)));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    orgUnitId: user.orgUnitId,
    roles: new Set(roleRows.map((r) => r.key)),
    permissions: new Set(perms.map((p) => p.p as Permission)),
    hodUnitIds: hodUnits.map((u) => u.id)
  };
}

export function can(actor: Actor, permission: Permission) {
  return actor.permissions.has(permission);
}

export function requirePermission(actor: Actor, permission: Permission, message?: string) {
  if (!actor.permissions.has(permission)) throw forbidden(message);
}
