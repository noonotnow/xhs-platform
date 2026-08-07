import { requireRednoteWorker } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteEventBody,
  readRednoteJson,
  requireRednoteWorkerCallbackIdentity,
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
    const principal = requireRednoteWorker(
      request.headers.get('authorization'),
    );
    const body = parseRednoteEventBody(await readRednoteJson(request));
    const result = await appendRednoteAttemptEvent({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      event: body,
      ...requireRednoteWorkerCallbackIdentity(request),
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'append_event',
      attemptId: params.id,
    });
  }
}
