import { NextRequest, NextResponse } from 'next/server';
import {
  parseRednotePublicationEvidence,
  readRednotePublicationEvidence,
  recordRednotePublicationEvidence,
} from '@/lib/rednote-publication-evidence';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function GET(
  request: NextRequest,
  context: { params: { noteId: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const evidence = await readRednotePublicationEvidence(
      workspaceId,
      context.params.noteId,
    );
    return NextResponse.json({ evidence }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: { noteId: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const input = parseRednotePublicationEvidence(
      context.params.noteId,
      await request.json(),
    );
    const evidence = await recordRednotePublicationEvidence(
      workspaceId,
      context.params.noteId,
      input,
    );
    return NextResponse.json({ evidence }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
