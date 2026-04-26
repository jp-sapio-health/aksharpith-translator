import { adminAuth } from './firebase-admin';
import { isAdminEmail } from './admins';

// Server-side guard. Returns the admin user or null.
// Authority comes from BOTH:
//   - the Firebase custom claim { admin: true } (set by scripts/seed-admin.mjs)
//   - the email allowlist in lib/admins.ts
// Both must agree to authorise.

export async function verifyAdminToken(req: Request): Promise<{ uid: string; email: string } | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = decoded.email || '';
    if (decoded.admin !== true) return null;
    if (!isAdminEmail(email)) return null;
    return { uid: decoded.uid, email };
  } catch {
    return null;
  }
}
