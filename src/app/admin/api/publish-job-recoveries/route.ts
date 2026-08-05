import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { parseRednotePublishJobRecoveryInput } from '@/lib/rednote-publish-job-recovery';
import { recoverStoredApprovedPublishJob } from '@/lib/rednote-publish-job-recovery-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
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
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Recovery body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const recovery = await recoverStoredApprovedPublishJob(
      parseRednotePublishJobRecoveryInput(body),
      operator.email,
    );
    return NextResponse.json(
      { recovery },
      { status: recovery.alreadyRecovered ? 200 : 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
