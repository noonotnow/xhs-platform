import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { readRednotePublishingOperational } from '@/lib/rednote-publishing-attempt-store';
import { getLocalPublishJobSummaries } from '@/lib/local-publish-jobs';
import { listOperatorSuccessAttestationEvidence } from '@/lib/operator-success-attestation-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
const HEADERS = { 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const workspace = request.headers.get('x-workspace-id');
  if (process.env.VERCEL_ENV !== 'preview' ||
      workspace !== 'phone-packets-publish-test-20261003') {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404, headers: HEADERS });
  }
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
  } catch {
    return NextResponse.json({ code: 'WORKER_AUTH_REQUIRED' }, { status: 401, headers: HEADERS });
  }
  async function measure(name: string, read: () => Promise<unknown>) {
    const started = Date.now();
    try {
      const detail = await read();
      return { name, ok: true, elapsedMs: Date.now() - started, detail };
    } catch (error) {
      const candidate = error && typeof error === 'object' && 'code' in error
        ? String(error.code) : 'DATABASE_READ_FAILED';
      return {
        name, ok: false, elapsedMs: Date.now() - started,
        code: /^[A-Z0-9_]{1,80}$/.test(candidate) ? candidate : 'DATABASE_READ_FAILED',
      };
    }
  }
  const connection = await measure('connection', async () => {
    await getPool().query('SELECT 1 AS diagnostic_connection');
    return { reachable: true };
  });
  const reads = connection.ok ? await Promise.all([
    measure('operational', async () => {
      const result = await readRednotePublishingOperational(workspace);
      return {
        queueCount: result.queue.length, attemptCount: result.attempts.length,
        workerOnline: result.worker.online, pollingActive: result.polling.active,
      };
    }),
    measure('jobs', async () => ({ count: (await getLocalPublishJobSummaries(workspace)).length })),
    measure('attestation', async () => ({ count: (await listOperatorSuccessAttestationEvidence(workspace)).length })),
  ]) : [];
  return NextResponse.json({
    verificationOnly: true, publicationApprovalRequested: false,
    capturedAt: new Date().toISOString(), steps: [connection, ...reads],
  }, { headers: HEADERS });
}
