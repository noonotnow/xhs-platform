import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteSupersedeBody,
  readRednoteJson,
  requireRednoteIdempotencyKey,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { supersedeRednoteAttempt } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const principal = await requireRednoteAdmin(request);
    const body = parseRednoteSupersedeBody(await readRednoteJson(request));
    const result = await supersedeRednoteAttempt({
      priorAttemptId: requireRednoteUuid(params.id, 'attemptId'),
      rawRequest: body.request,
      idempotencyKey: requireRednoteIdempotencyKey(request),
      expectedActiveAttemptId: body.expectedActiveAttemptId,
      occurredAt: body.occurredAt,
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'supersede',
      attemptId: params.id,
    });
  }
}
