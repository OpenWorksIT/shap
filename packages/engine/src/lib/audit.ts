import type { Db } from '../db/index.js';

export interface AuditEntry {
  userId?: string | null;
  actor?: 'user' | 'system' | 'import';
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string;
}

/** Append to the audit log (append-only, enforced by a database trigger). */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db`
    insert into audit_log (user_id, actor, action, entity, entity_id, details, ip)
    values (${e.userId ?? null}, ${e.actor ?? 'user'}, ${e.action}, ${e.entity}, ${e.entityId ?? null},
            ${db.json((e.details ?? {}) as never)}, ${e.ip ?? ''})
  `;
}
