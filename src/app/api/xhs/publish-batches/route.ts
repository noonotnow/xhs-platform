import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import {
  approvePublishBatch,
  createPublishBatch,
  listPublishBatches,
} from '@/lib/rednote-publish-batches';
import type { PublishBatchKind } from '@/types/local-publish-job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' };

export async function GET(request: NextRequest) {
  try {
    await validateCloudflareAccessRequest(request);
    return NextResponse.json(
      { batches: await listPublishBatches(request.nextUrl.searchParams.get('id') ?? undefined) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to list publish batches' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const operator = await validateCloudflareAccessRequest(request);
    const body = await request.json() as Record<string, unknown>;
    if (body.action === 'create') {
      if (!['weekly', 'catch_up', 'bootstrap'].includes(String(body.kind))) {
        throw new Error('kind must be weekly, catch_up, or bootstrap');
      }
      const batch = await createPublishBatch(body.kind as PublishBatchKind);
      return NextResponse.json({ batch }, { status: batch ? 201 : 200, headers: NO_STORE_HEADERS });
    }
    if (
      body.action === 'approve' &&
      body.confirmed === true &&
      typeof body.batchId === 'string' &&
      typeof body.manifestHash === 'string'
    ) {
      return NextResponse.json({
        batch: await approvePublishBatch(body.batchId, body.manifestHash, operator.email),
      }, { headers: NO_STORE_HEADERS });
    }
    throw new Error('A valid create or confirmed approve action is required');
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update publish batch' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
}
