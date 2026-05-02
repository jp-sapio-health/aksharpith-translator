import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextRequest } from 'next/server';
import { adminAuth } from '../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

// Vercel Blob upload-token handshake. The client SDK fetches this route to
// obtain a signed token; it then PUTs the file directly to Blob storage,
// bypassing Vercel's 4.5 MB serverless body limit.
//
// Auth note: the SDK does NOT forward custom headers (e.g. our Firebase
// Bearer token). Instead the client passes the Firebase ID token through the
// SDK's `clientPayload` field and we verify it inside onBeforeGenerateToken.
//
// MIME allowlist mirrors the upload route's accepted extensions.
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'text/plain',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
];

const MAX_BYTES = 100 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // clientPayload carries the Firebase ID token (plus optional metadata).
        // It's required — without it we cannot identify the user.
        if (!clientPayload) throw new Error('Missing auth token');
        let firebaseToken: string;
        try {
          const parsed = JSON.parse(clientPayload) as { firebaseToken?: string };
          if (!parsed.firebaseToken) throw new Error('Missing firebaseToken');
          firebaseToken = parsed.firebaseToken;
        } catch {
          throw new Error('Invalid client payload');
        }
        let uid: string;
        try {
          const decoded = await adminAuth.verifyIdToken(firebaseToken);
          uid = decoded.uid;
        } catch {
          throw new Error('Invalid Firebase token');
        }
        // Storage path convention: uploads/{uid}/... — confirm the client
        // didn't try to write to someone else's folder.
        if (!pathname.startsWith(`uploads/${uid}/`)) {
          throw new Error('Forbidden upload path');
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          tokenPayload: JSON.stringify({ uid }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Server-to-server callback fired by Vercel after the client PUT
        // completes. No client action needed; the browser independently POSTs
        // the blob URL to /api/upload to trigger extraction.
        const payload = tokenPayload ? JSON.parse(tokenPayload) as { uid: string } : null;
        console.log(`[blob] upload completed: ${blob.url} (uid=${payload?.uid ?? 'unknown'})`);
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    console.error('[blob-token] handleUpload error:', err);
    const message = err instanceof Error ? err.message : 'Could not generate upload token';
    return Response.json({ error: message }, { status: 400 });
  }
}
