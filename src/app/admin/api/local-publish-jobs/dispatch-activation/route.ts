import { NextRequest, NextResponse } from 'next/server';
import {
  activateDispatchActivation,
  cancelDispatchActivation,
  inspectDispatchActivation,
  prepareDispatchActivation,
  releaseDispatchActivation,
} from '@/lib/local-publish-dispatch-activation';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { requireXhsOperatorIdentity } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

async function operator(request: NextRequest) {
  const result = await requireXhsOperatorIdentity(request);
  if ('response' in result) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      result.response.headers.set(name, value);
    }
  }
  return result;
}

export async function GET(request: NextRequest) {
  const auth = await operator(request);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json(
      await inspectDispatchActivation(),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('Dispatch activation inspection failed', error);
    return NextResponse.json(
      {
        error: 'Dispatch activation status is unavailable.',
        code: 'DISPATCH_ACTIVATION_STATUS_UNAVAILABLE',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await operator(request);
  if ('response' in auth) return auth.response;
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      throw new LocalPublishJobError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    if (body.action === 'prepare') {
      const jobId = String(body.jobId ?? '');
      if (body.confirm !== `PREPARE EXACT DISPATCH ${jobId}`) {
        throw new LocalPublishJobError(
          'Exact prepare confirmation is required',
          'DISPATCH_ACTIVATION_CONFIRMATION_REQUIRED',
          400,
        );
      }
      const prepared = await prepareDispatchActivation({
        workspaceId: String(body.workspaceId ?? ''),
        jobId,
        batchId: String(body.batchId ?? ''),
        itemId: String(body.itemId ?? ''),
        manifestHash: String(body.manifestHash ?? ''),
        itemHash: String(body.itemHash ?? ''),
        sourceRevision: String(body.sourceRevision ?? ''),
        generation: Number(body.generation),
        expectedWorkerId: String(body.expectedWorkerId ?? ''),
        expectedWorkerContractRevision:
          String(body.expectedWorkerContractRevision ?? ''),
        expectedWorkerCompatibilityRevision:
          String(body.expectedWorkerCompatibilityRevision ?? ''),
        expectedWorkerReleaseId:
          String(body.expectedWorkerReleaseId ?? ''),
        expectedWorkerAttestationId:
          String(body.expectedWorkerAttestationId ?? ''),
        ...(body.ttlMinutes === undefined
          ? {}
          : { ttlMinutes: Number(body.ttlMinutes) }),
      }, auth.identity);
      return NextResponse.json(prepared, { status: 201, headers: NO_STORE_HEADERS });
    }
    if (body.action === 'activate') {
      const activationId = String(body.activationId ?? '');
      if (body.confirm !== `ACTIVATE EXACT DISPATCH ${activationId}`) {
        throw new LocalPublishJobError(
          'Exact activation confirmation is required',
          'DISPATCH_ACTIVATION_CONFIRMATION_REQUIRED',
          400,
        );
      }
      return NextResponse.json({
        activation: await activateDispatchActivation(
          activationId,
          String(body.nonce ?? ''),
          auth.identity,
        ),
      }, { headers: NO_STORE_HEADERS });
    }
    if (body.action === 'release') {
      const activationId = String(body.activationId ?? '');
      if (body.confirm !== `RELEASE EXACT DISPATCH ${activationId}`) {
        throw new LocalPublishJobError(
          'Exact release confirmation is required',
          'DISPATCH_ACTIVATION_CONFIRMATION_REQUIRED',
          400,
        );
      }
      return NextResponse.json({
        activation: await releaseDispatchActivation(
          activationId,
          auth.identity,
          String(body.releaseReason ?? ''),
        ),
      }, { headers: NO_STORE_HEADERS });
    }
    if (body.action === 'cancel') {
      const activationId = String(body.activationId ?? '');
      if (body.confirm !== `CANCEL EXACT DISPATCH ${activationId}`) {
        throw new LocalPublishJobError(
          'Exact cancellation confirmation is required',
          'DISPATCH_ACTIVATION_CONFIRMATION_REQUIRED',
          400,
        );
      }
      return NextResponse.json({
        activation: await cancelDispatchActivation(
          activationId,
          auth.identity,
          String(body.cancellationReason ?? ''),
        ),
      }, { headers: NO_STORE_HEADERS });
    }
    throw new LocalPublishJobError(
      'action must be prepare, activate, cancel, or release',
      'VALIDATION_ERROR',
      400,
    );
  } catch (error) {
    if (error instanceof LocalPublishJobError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }
    console.error('Dispatch activation mutation failed', error);
    return NextResponse.json(
      {
        error: 'Dispatch activation could not be changed.',
        code: 'DISPATCH_ACTIVATION_FAILED',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
