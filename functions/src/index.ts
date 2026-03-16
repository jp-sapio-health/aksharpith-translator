import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (getApps().length === 0) initializeApp();
const db = getFirestore();

// Define secrets (set via firebase functions:secrets:set)
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

// ─── Inline pipeline logic ──────────────────────────────────────────────────
// Firebase Functions can't import from outside the functions/ directory at
// runtime (no monorepo symlinks). The pipeline is imported at build time via
// a build step that copies lib/ into functions/src/. See functions/package.json
// "prebuild" script. For now, we import the compiled version.

import { runPipeline } from './pipeline';
import type { JobProgressUpdate } from './job-types';

export const processTranslation = onDocumentCreated(
  {
    document: 'jobs/{jobId}',
    secrets: [anthropicApiKey],
    timeoutSeconds: 540, // 9 minutes
    memory: '1GiB',
    region: 'us-central1',
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const jobId = event.params.jobId;
    const data = snapshot.data();

    // Only process pending jobs
    if (data.status !== 'pending') return;

    const { input, uid, email } = data;
    if (!input?.text) {
      await db.collection('jobs').doc(jobId).update({
        status: 'failed',
        error: 'No text provided',
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // Set ANTHROPIC_API_KEY in process.env for pipeline
    process.env.ANTHROPIC_API_KEY = anthropicApiKey.value();

    // Progress reporter: writes updates to Firestore job doc
    const reportProgress = async (update: JobProgressUpdate) => {
      const firestoreUpdate: Record<string, unknown> = {};
      if (update.status) firestoreUpdate.status = update.status;
      if (update.startedAt) firestoreUpdate.startedAt = update.startedAt;
      if (update.completedAt) firestoreUpdate.completedAt = update.completedAt;
      if (update.error) firestoreUpdate.error = update.error;
      if (update.result) firestoreUpdate.result = update.result;
      if (update.progress) {
        if (update.progress.currentStage) firestoreUpdate['progress.currentStage'] = update.progress.currentStage;
        if (update.progress.chunks) firestoreUpdate['progress.chunks'] = update.progress.chunks;
        if (update.progress.stages) {
          for (const [stage, stageData] of Object.entries(update.progress.stages)) {
            for (const [key, val] of Object.entries(stageData as Record<string, unknown>)) {
              firestoreUpdate[`progress.stages.${stage}.${key}`] = val;
            }
          }
        }
      }
      await db.collection('jobs').doc(jobId).update(firestoreUpdate);
    };

    try {
      await runPipeline(
        input,
        { uid, email },
        reportProgress,
        db,
      );
    } catch (err) {
      console.error(`Pipeline error for job ${jobId}:`, err);
      await db.collection('jobs').doc(jobId).update({
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
        completedAt: new Date().toISOString(),
      });
    }
  },
);
