import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { parseOperatorAttestedReceipt } from '@/lib/operator-success-attestation';
import { recordOperatorAttestedReceipt } from '@/lib/operator-success-attestation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    if (!UUID.test(params.id)) {
      throw new LocalPublishJobError('Invalid local publish job id', 'VALIDATION_ERROR', 400);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError('Receipt body must be valid JSON', 'VALIDATION_ERROR', 400);
    }
    const input = parseOperatorAttestedReceipt(body);
    const attestation = await recordOperatorAttestedReceipt(params.id.toLowerCase(), input);
    return NextResponse.json({ attestation }, { headers: HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: HEADERS },
    );
  }
}
