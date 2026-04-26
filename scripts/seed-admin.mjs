#!/usr/bin/env node
/**
 * Bootstrap admin users in Firebase Auth.
 *
 * Reads ADMIN_PASSWORD from the environment ONLY — never accepts it as an arg
 * (would land in shell history) and never reads it from any file.
 *
 * Usage:
 *   read -s -p "Admin password: " ADMIN_PASSWORD; export ADMIN_PASSWORD
 *   node scripts/seed-admin.mjs
 *   unset ADMIN_PASSWORD
 *
 * For each admin email:
 *   1. Creates the user if absent (emailVerified = true)
 *   2. Or updates the existing user's password
 *   3. Sets custom claim { admin: true } so the role flows through ID tokens
 *      and Firestore rules can check request.auth.token.admin == true.
 *
 * Admins must sign out and back in for the new claim to take effect on the client.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Mirror of lib/admins.ts. Edit BOTH lists in lockstep.
// Kept as plain JS so this script doesn't need tsx.
const ADMIN_EMAILS = [
  'jay@bapstranslator.com',
  'svd@bapstranslator.com',
];

// ── Env loader (matches local-worker.mjs) ───────────────────────────────────

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf-8');
    const vars = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?([\s\S]*?)["']?\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    return vars;
  } catch {
    return {};
  }
}

const env = {
  ...loadEnvFile(resolve(ROOT, '.env.local')),
  ...loadEnvFile(resolve(ROOT, '.env.vercel.local')),
};

// ── Validate inputs ─────────────────────────────────────────────────────────

const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error('Error: ADMIN_PASSWORD env var is required.');
  console.error('Usage: read -s -p "Admin password: " ADMIN_PASSWORD; export ADMIN_PASSWORD');
  console.error('       node scripts/seed-admin.mjs');
  console.error('       unset ADMIN_PASSWORD');
  process.exit(1);
}

if (password.length < 6) {
  console.error('Error: password too short. Firebase Auth minimum is 6 characters.');
  process.exit(1);
}

if (password.length < 12) {
  console.warn('Warning: password is shorter than 12 characters. Consider strengthening.');
}

const PROJECT_ID = env.FIREBASE_PROJECT_ID || 'aksharpith-translator';
const CLIENT_EMAIL = env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error('Error: missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .env.local');
  process.exit(1);
}

// ── Run ─────────────────────────────────────────────────────────────────────

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

if (getApps().length === 0) {
  initializeApp({ credential: cert({ projectId: PROJECT_ID, clientEmail: CLIENT_EMAIL, privateKey: PRIVATE_KEY }) });
}
const auth = getAuth();

console.log(`Seeding ${ADMIN_EMAILS.length} admin(s) on project: ${PROJECT_ID}\n`);

let succeeded = 0;
let failed = 0;

for (const email of ADMIN_EMAILS) {
  let uid;
  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    await auth.updateUser(uid, { password, emailVerified: true });
    console.log(`✓ Updated  ${email.padEnd(30)} uid=${uid}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      try {
        const created = await auth.createUser({ email, password, emailVerified: true });
        uid = created.uid;
        console.log(`✓ Created  ${email.padEnd(30)} uid=${uid}`);
      } catch (createErr) {
        console.error(`✗ Failed   ${email.padEnd(30)} ${createErr.message}`);
        failed++;
        continue;
      }
    } else {
      console.error(`✗ Failed   ${email.padEnd(30)} ${err.message}`);
      failed++;
      continue;
    }
  }

  try {
    await auth.setCustomUserClaims(uid, { admin: true });
    console.log(`           ${''.padEnd(30)} customClaim { admin: true } set`);
    succeeded++;
  } catch (claimErr) {
    console.error(`✗ Claim    ${email.padEnd(30)} ${claimErr.message}`);
    failed++;
  }
}

console.log(`\nDone: ${succeeded} succeeded, ${failed} failed.`);
console.log('\nAdmins must sign out and sign back in for the new claim to take effect in the browser.');

if (failed > 0) process.exit(1);
