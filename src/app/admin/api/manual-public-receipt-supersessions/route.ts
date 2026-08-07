import { NextRequest, NextResponse } from 'next/server';
import { adminApiHeaders } from '@/lib/admin-api-response';
import { LocalPublishJobError, parseIdempotencyKey } from
  '@/lib/local-publish-job-input';
import { createManualPublicReceiptSupersession } from
  '@/lib/manual-public-receipt-supersessions';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { authenticateXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const RESPONSE_HEADERS = adminApiHeaders('manual-public-receipt-supersessions/v1');

function errorResponse(error: unknown) {
  const known = normalizeLocalPublishJobError(error);
  return NextResponse.json(
    { error: known.message, code: known.code },
    { status: known.status, headers: RESPONSE_HEADERS },
  );
}

export async function POST(request: NextRequest) {
  let operator: Awaited<ReturnType<typeof authenticateXhsOperator>>;
  try {
    operator = await authenticateXhsOperator(request);
  } catch {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: RESPONSE_HEADERS },
    );
  }
  try {
    const idempotencyKey = parseIdempotencyKey(
      request.headers.get('idempotency-key'),
    );
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
    const result = await createManualPublicReceiptSupersession(
      body,
      idempotencyKey,
      operator.email,
    );
    return NextResponse.json(
      {
        supersession: result.supersession,
        reconciliation: result.reconciliation,
      },
      {
        status: result.created ? 201 : 200,
        headers: RESPONSE_HEADERS,
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
