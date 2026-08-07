import { requireRednoteWorker } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteClaimBody,
  readRednoteJson,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { claimRednoteAttempt } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const principal = requireRednoteWorker(
      request.headers.get('authorization'),
    );
    const body = parseRednoteClaimBody(await readRednoteJson(request));
    const result = await claimRednoteAttempt({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      ...body,
      principal,
    });
    return rednoteJson(result);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'claim',
      attemptId: params.id,
    });
  }
}
