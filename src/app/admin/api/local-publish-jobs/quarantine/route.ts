import { NextRequest, NextResponse } from 'next/server';
import {
  LocalPublishJobError,
  parseIdempotencyKey,
} from '@/lib/local-publish-job-input';
import {
  inventoryLocalPublishQueue,
  quarantineLocalPublishQueue,
} from '@/lib/local-publish-queue-quarantine';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

async function authorize(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
  }
  return unauthorized;
}

export async function GET(request: NextRequest) {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(
      { inventory: await inventoryLocalPublishQueue() },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('Local publish queue inventory failed', error);
    return NextResponse.json(
      {
        error: 'Local publish queue inventory is unavailable.',
        code: 'QUEUE_INVENTORY_UNAVAILABLE',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json() as {
      confirm?: unknown;
      dryRun?: unknown;
    };
    const keys = Object.keys(body).sort();
    if (
      keys.length !== 2
      || keys[0] !== 'confirm'
      || keys[1] !== 'dryRun'
      || body.confirm !== 'QUARANTINE_ALL_EXISTING_LOCAL_PUBLISH_JOBS'
      || typeof body.dryRun !== 'boolean'
    ) {
      return NextResponse.json(
        {
          error: 'Exact queue quarantine confirmation is required.',
          code: 'QUEUE_QUARANTINE_CONFIRMATION_REQUIRED',
        },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (body.dryRun) {
      return NextResponse.json(
        { dryRun: true, inventory: await inventoryLocalPublishQueue() },
        { headers: NO_STORE_HEADERS },
      );
    }
    const idempotencyKey = parseIdempotencyKey(
      request.headers.get('idempotency-key'),
    );
    const result = await quarantineLocalPublishQueue(idempotencyKey);
    return NextResponse.json(
      { dryRun: false, ...result },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof LocalPublishJobError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }
    console.error('Local publish queue quarantine failed', error);
    return NextResponse.json(
      {
        error: 'Local publish queue quarantine could not be completed.',
        code: 'QUEUE_QUARANTINE_FAILED',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
