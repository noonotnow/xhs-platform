import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteEventBody,
  readRednoteJson,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { appendRednoteAttemptEvent } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const principal = await requireRednoteAdmin(request);
    const body = parseRednoteEventBody(await readRednoteJson(request));
    const result = await appendRednoteAttemptEvent({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      event: body,
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'admin_append_event',
      attemptId: params.id,
    });
  }
}
