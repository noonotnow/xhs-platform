import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import {
  parseBrowserClosedPublishJobRecoveryInput,
  parseRednotePublishJobRecoveryInput,
} from '@/lib/rednote-publish-job-recovery';
import {
  recoverStoredApprovedPublishJob,
  recoverStoredBrowserClosedPrePublishJob,
} from '@/lib/rednote-publish-job-recovery-store';
import {
  BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
} from '@/lib/rednote-publish-job-recovery-contract';
import type {
  PublicRednotePublishJobRecovery,
  RednotePublishJobRecovery,
} from '@/types/local-publish-job';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

function publicRecovery(
  recovery: RednotePublishJobRecovery,
): PublicRednotePublishJobRecovery {
  return {
    id: recovery.id,
    batchId: recovery.batchId,
    manifestHash: recovery.manifestHash,
    itemId: recovery.itemId,
    jobId: recovery.jobId,
    itemHash: recovery.itemHash,
    snapshotRevision: recovery.snapshotRevision,
    approvedAt: recovery.approvedAt,
    recoveredAt: recovery.recoveredAt,
    priorClaimAttempts: recovery.priorClaimAttempts,
    alreadyRecovered: recovery.alreadyRecovered,
  };
}

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
    const browserClosedRecovery = Boolean(
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).confirmed ===
        BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
    );
    const input = browserClosedRecovery
      ? parseBrowserClosedPublishJobRecoveryInput(body)
      : parseRednotePublishJobRecoveryInput(body);
    const recovery = browserClosedRecovery
      ? await recoverStoredBrowserClosedPrePublishJob(input, operator.email)
      : await recoverStoredApprovedPublishJob(input, operator.email);
    return NextResponse.json(
      { recovery: publicRecovery(recovery) },
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
