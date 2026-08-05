import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { parseOperatorSuccessAttestation } from '@/lib/operator-success-attestation';
import { attestStoredScheduledAmbiguity } from '@/lib/operator-success-attestation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(request: NextRequest) {
  let operator;
  try {
    operator = await validateCloudflareAccessRequest(request);
  } catch {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: HEADERS },
    );
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Attestation body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await attestStoredScheduledAmbiguity(
      parseOperatorSuccessAttestation(body),
      operator.email,
    );
    return NextResponse.json(
      { attestation: result.attestation, release: result.release },
      { status: result.created ? 201 : 200, headers: HEADERS },
    );
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: HEADERS },
    );
  }
}
