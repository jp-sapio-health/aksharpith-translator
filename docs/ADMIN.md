# Admin Setup

Two admins, hardcoded by email allowlist:

- `jay@bapstranslator.com`
- `svd@bapstranslator.com`

The domain is **identifier only** — Firebase Auth treats the email as a unique key. We don't own DNS, so password-reset emails will not deliver. To rotate a password, re-run the seed script.

## One-time bootstrap

```bash
cd web

# Type the password interactively (won't land in shell history):
read -s -p "Admin password: " ADMIN_PASSWORD; export ADMIN_PASSWORD; echo

# Seed the users
npm run admin:seed

# Forget it
unset ADMIN_PASSWORD
```

The script:
1. Creates each admin in Firebase Auth (or updates the password if they exist)
2. Sets `customClaim { admin: true }` on each
3. Marks `emailVerified: true`

After seeding, both admins must **sign out and back in** for the new claim to flow into their browser ID token.

## Adding or removing an admin

Edit two lists in lockstep:

1. [lib/admins.ts](../lib/admins.ts) — `ADMIN_EMAILS` (TypeScript, used by the dashboard guard and server-side helpers)
2. [scripts/seed-admin.mjs](../scripts/seed-admin.mjs) — `ADMIN_EMAILS` (plain JS so the script doesn't need tsx)

Re-run `npm run admin:seed` to apply.

To revoke admin without deleting the user, remove from both lists, then run:

```bash
node -e "
import('firebase-admin/app').then(async ({initializeApp, cert}) => {
  const { getAuth } = await import('firebase-admin/auth');
  initializeApp({ credential: cert({ /* env */ }) });
  await getAuth().setCustomUserClaims('<uid>', { admin: false });
});
"
```

## Firestore rules

[firestore.rules](../firestore.rules) defines `isAdmin()` as `request.auth.token.admin == true`. Admins can read all jobs and all translations across users; writes remain owner-only or server-only.

Deploy rule changes with:

```bash
firebase deploy --only firestore:rules
```

## Dashboard

Visit `/admin` while signed in as an admin. The page:

- Verifies admin status via `getIdTokenResult({forceRefresh: true})` + email allowlist
- Subscribes to `jobs` collection via `onSnapshot` (live updates, no polling)
- Shows status filter chips, stats bar, per-job drilldown with stages + commentary + chunk grid

Non-admins see a friendly "access required" message.

## Security notes

- The password is **never** stored in source, env files, or commits. It only lives in process env during the seed run.
- Sapio's push protection enforces this — a hardcoded `Mahant1234` (or any password literal) would fail to push.
- Both admin emails currently share the same password. Rotate periodically; consider per-user passwords if SVD's use case diverges.
- `bapstranslator.com` is not under your control. Treat the addresses as **identifiers**, not mailboxes.
