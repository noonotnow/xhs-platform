import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  parseLocalPublishWorkerHeartbeat,
  upsertLocalPublishWorkerHeartbeat,
} from '@/lib/local-publish-worker-heartbeat';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new LocalPublishJobError('Heartbeat body must be valid JSON', 'VALIDATION_ERROR', 400);
    }
    const heartbeat = await upsertLocalPublishWorkerHeartbeat(
      workspaceId,
      parseLocalPublishWorkerHeartbeat(raw),
    );
    return NextResponse.json({ heartbeat }, { headers: NO_STORE });
  } catch (error) {
    const known = error instanceof LocalPublishJobError
      ? error
      : new LocalPublishJobError('Worker heartbeat could not be recorded', 'WORKER_HEARTBEAT_FAILED', 503);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status,
      headers: { ...NO_STORE, ...(known.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) },
    });
  }
}