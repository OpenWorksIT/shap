/**
 * The server's own, never done from the demo company or a client's books (Shap Accountant): its
 * updates and backups, its security audit, the feedback inbox, and wiping the books. Both walls
 * read this one list (demo.ts, practice.ts), and the security tests try each route behind both.
 */
export const SERVER_ONLY = ['/api/system', '/api/feedback', '/api/wipe', '/api/audit/server'] as const;

/** Is this route one of these, or under one? */
export const under = (path: string, bases: readonly string[]) => bases.some((b) => path === b || path.startsWith(`${b}/`));
