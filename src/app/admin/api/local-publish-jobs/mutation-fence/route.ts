import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { fenceReadyX3SourceMutation } from '@/lib/rednote-publishing-attempt-store';
import { parseWorkspaceId } from '@/lib/workspace-id';
import { readReadyX3SourceMutationSafety } from '@/lib/ready-x3-source-mutation-safety';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

// A distinct read-only HTTP method fails closed against older deployments:
// unlike a new POST flag, it cannot accidentally revoke an authorization.
export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) unauthorized.headers.set(name, value);
    return unauthorized;
  }
  try {
    const notionPageId = request.nextUrl.searchParams.get('notionPageId')?.trim();
    const lastEditedTime = request.nextUrl.searchParams.get('lastEditedTime')?.trim();
    if (!notionPageId || !lastEditedTime || !Number.isFinite(Date.parse(lastEditedTime))) {
      throw new LocalPublishJobError('notionPageId and a valid lastEditedTime are required', 'VALIDATION_ERROR', 400);
    }
    const result = await readReadyX3SourceMutationSafety(
      parseWorkspaceId(request.headers.get('x-workspace-id')), notionPageId,
    );
    return NextResponse.json({
      contractVersion: 'ready-x3/source-mutation-safety/v1',
      notionPageId, lastEditedTime, ...result,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = error instanceof LocalPublishJobError ? error :
      new LocalPublishJobError('Ready x3 source mutation truth is unavailable', 'READY_X3_MUTATION_TRUTH_UNAVAILABLE', 503);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status, headers: NO_STORE_HEADERS,
    });
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalPublishJobError('Request body must be a JSON object', 'VALIDATION_ERROR', 400);
    }
    const value = body as Record<string, unknown>;
    if (typeof value.notionPageId !== 'string' || !value.notionPageId.trim() ||
      typeof value.lastEditedTime !== 'string' || !value.lastEditedTime.trim()) {
      throw new LocalPublishJobError('notionPageId and lastEditedTime are required', 'VALIDATION_ERROR', 400);
    }
    const result = await fenceReadyX3SourceMutation(
      parseWorkspaceId(request.headers.get('x-workspace-id')),
      value.notionPageId.trim(),
      value.lastEditedTime.trim(),
    );
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = error instanceof LocalPublishJobError
      ? error
      : new LocalPublishJobError('Unable to fence Ready x3 source mutation', 'READY_X3_FENCE_FAILED', 503);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status, headers: NO_STORE_HEADERS,
    });
  }
}