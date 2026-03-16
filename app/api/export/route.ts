import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from 'docx';
import { parseOutputSections } from '../../../lib/parse-output';

export async function POST(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.format !== 'string') {
    return NextResponse.json({ error: 'Missing format' }, { status: 400 });
  }

  const { translationId, format, output } = body as {
    translationId?: string;
    format: 'docx' | 'docx-reviews' | 'training-json';
    output?: string;
  };

  // Fetch translation doc if we have an ID
  let translationDoc: FirebaseFirestore.DocumentData | null = null;
  if (translationId) {
    const snap = await adminDb.collection('translations').doc(translationId).get();
    if (snap.exists) translationDoc = snap.data() ?? null;
  }

  const text = output ?? translationDoc?.output ?? '';

  // ─── Training JSON export ───────────────────────────────────────────────
  if (format === 'training-json') {
    let reviews: Array<Record<string, unknown>> = [];
    if (translationId) {
      const reviewSnap = await adminDb
        .collection('translations')
        .doc(translationId)
        .collection('reviews')
        .orderBy('createdAt', 'asc')
        .get();
      reviews = reviewSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    const trainingData = {
      translationId: translationId ?? null,
      inputPreview: translationDoc?.inputPreview ?? null,
      inputWordCount: translationDoc?.inputWordCount ?? null,
      outputWordCount: translationDoc?.outputWordCount ?? null,
      avgScore: translationDoc?.avgScore ?? null,
      chapterTitle: translationDoc?.chapterTitle ?? null,
      output: text,
      reviews,
      exportedAt: new Date().toISOString(),
      exportedBy: authUser.email,
    };

    return NextResponse.json(trainingData);
  }

  // ─── DOCX export ────────────────────────────────────────────────────────
  const sections = parseOutputSections(text);
  const paragraphs: Paragraph[] = [];

  // Title
  if (translationDoc?.chapterTitle) {
    paragraphs.push(new Paragraph({
      text: translationDoc.chapterTitle,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }));
  }

  // Meta line
  paragraphs.push(new Paragraph({
    children: [
      new TextRun({
        text: `Aksharpith Translation Pipeline | Score: ${translationDoc?.avgScore ?? 'N/A'}% | ${new Date().toLocaleDateString('en-GB')}`,
        size: 18, color: '888888', italics: true,
      }),
    ],
    spacing: { after: 300 },
  }));

  for (const section of sections) {
    if (section.type === 'verse') {
      // Verse block with left border styling
      const verseLines = section.content.split('\n').filter(l => l.trim());
      for (const line of verseLines) {
        const isTranslit = /[āīūṛṅñṭḍṇśṣḥ]/.test(line) || /^[\u201c\u201d]/.test(line);
        const isMeaning = /^\(.*\)$/.test(line);
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: line,
              italics: isTranslit,
              size: isMeaning ? 20 : 22,
              color: isMeaning ? '666666' : '333333',
            }),
          ],
          indent: { left: 720 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 6, color: 'CC9900', space: 10 },
          },
          spacing: { after: 60 },
        }));
      }
      paragraphs.push(new Paragraph({ spacing: { after: 200 } }));
    } else {
      // Prose paragraph
      paragraphs.push(new Paragraph({
        children: [
          new TextRun({
            text: section.content,
            size: 24,
            font: 'Garamond',
          }),
        ],
        spacing: { after: 200, line: 360 },
      }));
    }
  }

  // ─── Reviews section (if requested) ─────────────────────────────────────
  if (format === 'docx-reviews' && translationId) {
    const reviewSnap = await adminDb
      .collection('translations')
      .doc(translationId)
      .collection('reviews')
      .orderBy('createdAt', 'asc')
      .get();

    if (!reviewSnap.empty) {
      paragraphs.push(new Paragraph({ spacing: { after: 400 } }));
      paragraphs.push(new Paragraph({
        text: 'Review Comments',
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      }));

      for (const doc of reviewSnap.docs) {
        const review = doc.data();
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: `Section ${(review.sectionIndex ?? 0) + 1} \u2014 `,
              bold: true, size: 20,
            }),
            new TextRun({
              text: `${review.displayName || review.email || 'Anonymous'} (${new Date(review.createdAt).toLocaleDateString('en-GB')})`,
              size: 20, color: '666666',
            }),
          ],
          spacing: { after: 60 },
        }));
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: review.comment ?? '',
              size: 20, italics: true,
            }),
          ],
          spacing: { after: 200 },
          indent: { left: 360 },
        }));
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs,
    }],
  });

  const buffer = await Packer.toBuffer(doc);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="translation.docx"`,
    },
  });
}
