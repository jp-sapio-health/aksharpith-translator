// Admin email allowlist. Identifier strings only — passwords NEVER live in source.
// To grant or revoke admin access, edit this list and re-run scripts/seed-admin.mjs.
//
// Admin authority is enforced in two places that must agree:
//   1. This list (server-side checks in lib/admin-auth.ts and middleware)
//   2. Firebase custom claim { admin: true } applied by scripts/seed-admin.mjs
//      (read by Firestore rules via request.auth.token.admin)

export const ADMIN_EMAILS = [
  'jay@bapstranslator.com',
  'svd@bapstranslator.com',
] as const;

export type AdminEmail = typeof ADMIN_EMAILS[number];

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (ADMIN_EMAILS as readonly string[]).includes(email);
}
