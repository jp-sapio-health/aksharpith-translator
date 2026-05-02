import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';

export const dynamic = 'force-dynamic';

// Vercel Blob upload-token handshake. The client SDK calls this route to
// obtain a signed token; it then PUTs the file directly to Blob storage,
// bypassing Vercel's 4.5 MB serverless body limit. Auth is enforced before
// any token is issued.
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
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_BYTES,
        // Embed the uid so the upload-completed callback can verify the
        // pathname matches the authenticated user.
        tokenPayload: JSON.stringify({ uid: authUser.uid }),
      }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Server-side notification — Vercel calls this after the client-side
        // upload finishes. We don't need to do anything here; the client will
        // POST the blob URL to /api/upload to trigger extraction.
        const payload = tokenPayload ? JSON.parse(tokenPayload) as { uid: string } : null;
        console.log(`[blob] upload completed: ${blob.url} (uid=${payload?.uid ?? 'unknown'})`);
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    console.error('[blob-token] handleUpload error:', err);
    return Response.json({ error: 'Could not generate upload token' }, { status: 400 });
  }
}
