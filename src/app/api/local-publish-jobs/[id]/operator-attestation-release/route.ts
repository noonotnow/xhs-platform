import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import {
  getOperatorAttestationRelease,
  recordLocalPublishWorkerCapabilities,
} from '@/lib/operator-success-attestation-store';
import { workerCapabilities } from '@/lib/operator-success-attestation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    await recordLocalPublishWorkerCapabilities(
      workerCapabilities(request.headers.get('x-local-publish-worker-capabilities')),
    );
    const token = request.headers.get('x-local-publish-claim-token');
    if (!UUID.test(params.id) || !token || !UUID.test(token)) {
      throw new LocalPublishJobError('Exact job and prior claim token are required', 'VALIDATION_ERROR', 400);
    }
    const release = await getOperatorAttestationRelease(params.id.toLowerCase(), token);
    if (!release) return new NextResponse(null, { status: 204, headers: HEADERS });
    return NextResponse.json({ release }, { headers: HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: HEADERS },
    );
  }
}
