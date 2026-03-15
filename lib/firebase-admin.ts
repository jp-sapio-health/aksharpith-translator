import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'aksharpith-translator';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  } else {
    // Fallback: try loading from service account file (local dev)
    initializeApp({ projectId });
  }
}

export const adminAuth = getAuth();
export const adminDb = getFirestore();
