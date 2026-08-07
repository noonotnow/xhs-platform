import { NextRequest, NextResponse } from 'next/server';
import { adminApiHeaders } from '@/lib/admin-api-response';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { parseIdempotencyKey, LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  getLocalPublishJobSummaries,
  normalizeLocalPublishJobError,
  queueLocalPublishJob,
} from '@/lib/local-publish-jobs';
import { listOperatorSuccessAttestationEvidence } from '@/lib/operator-success-attestation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const RESPONSE_HEADERS = adminApiHeaders('local-publish-jobs/v1');

function errorResponse(error: unknown) {
  const known = normalizeLocalPublishJobError(error);
  return NextResponse.json(
    { error: known.message, code: known.code },
    { status: known.status, headers: RESPONSE_HEADERS },
  );
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }

  try {
    const [jobs, successAttestationCandidates] = await Promise.all([
      getLocalPublishJobSummaries(),
      listOperatorSuccessAttestationEvidence(),
    ]);
    return NextResponse.json(
      { jobs, successAttestationCandidates },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }

  try {
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await queueLocalPublishJob(body, idempotencyKey);
    return NextResponse.json(
      { job: result.job },
      { status: result.created ? 201 : 200, headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
