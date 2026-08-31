import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getReadyXhsPost } from '@/lib/notion-posts';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valueType(value: unknown) {
  if (Array.isArray(value)) return 'array';
  return value === null ? 'null' : typeof value;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => {
      unauthorized.headers.set(key, value);
    });
    return unauthorized;
  }

  const rawJobId =
    request.headers.get('x-local-publish-job-id')
    ?? request.nextUrl.searchParams.get('jobId');
  const jobId = rawJobId?.trim() ?? null;
  if (!jobId || !UUID_PATTERN.test(jobId)) {
    return NextResponse.json(
      {
        error: 'One exact jobId UUID is required.',
        code: 'VALIDATION_ERROR',
        deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        receivedJobId: jobId,
        receivedLength: jobId?.length ?? null,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
  const result = await getPool().query<{
    status: string;
    notion_page_id: string;
    snapshot: Record<string, unknown>;
    authorization_kind: string | null;
    browser_payload: Record<string, unknown> | null;
  }>(
    `SELECT job.status, job.notion_page_id, job.snapshot,
            attempt.authorization_kind,
            attempt.frozen_payload->'browserPayload' AS browser_payload
       FROM local_publish_jobs AS job
       LEFT JOIN LATERAL (
         SELECT authorization_kind, frozen_payload
           FROM rednote_publish_attempts
          WHERE workspace_id = job.workspace_id
            AND source_local_publish_job_id = job.id
          ORDER BY created_at DESC
          LIMIT 1
       ) AS attempt ON TRUE
      WHERE job.workspace_id = $1
        AND job.id = $2::uuid
      LIMIT 1`,
    [workspaceId, jobId],
  );
  const row = result.rows[0];
  if (!row) {
    return NextResponse.json(
      { error: 'The local publish job was not found.', code: 'JOB_NOT_FOUND' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const post = await getReadyXhsPost(row.notion_page_id);
  const frozen = row.browser_payload ?? {};
  const serializedClaimFieldTypes = {
    headline: valueType(post.headline?.trim()),
    title: valueType(frozen.title),
    caption: valueType(frozen.caption),
    tags: valueType(frozen.tags),
  };

  return NextResponse.json(
    {
      deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      jobId,
      status: row.status,
      authorizationKind: row.authorization_kind,
      storedSnapshotFieldTypes: {
        headline: valueType(row.snapshot.headline),
        title: valueType(row.snapshot.title),
        caption: valueType(row.snapshot.caption),
        tags: valueType(row.snapshot.tags),
      },
      frozenPayloadFieldTypes: {
        title: valueType(frozen.title),
        caption: valueType(frozen.caption),
        tags: valueType(frozen.tags),
      },
      serializedClaimFieldTypes,
      serializedClaimValid:
        serializedClaimFieldTypes.headline === 'string'
        && serializedClaimFieldTypes.title === 'string'
        && serializedClaimFieldTypes.caption === 'string'
        && serializedClaimFieldTypes.tags === 'array',
    },
    { headers: NO_STORE_HEADERS },
  );
}