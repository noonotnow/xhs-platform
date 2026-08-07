import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteTransferBody,
  readRednoteJson,
  requireRednoteIdempotencyKey,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { transferRednoteOperatorResolution } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const principal = await requireRednoteAdmin(request);
    const body = parseRednoteTransferBody(await readRednoteJson(request));
    const result = await transferRednoteOperatorResolution({
      priorOperatorAttemptId: requireRednoteUuid(params.id, 'attemptId'),
      rawRequest: body.request,
      idempotencyKey: requireRednoteIdempotencyKey(request),
      occurredAt: body.occurredAt,
      reason: body.reason,
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'operator_transfer',
      attemptId: params.id,
    });
  }
}
