import { requireRednoteWorker } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteOutcomeBody,
  readRednoteJson,
  requireRednoteWorkerCallbackIdentity,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { recordRednoteTerminalOutcome } from '@/lib/rednote-publishing';

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
    const result = await recordRednoteTerminalOutcome({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      ...parseRednoteOutcomeBody(await readRednoteJson(request)),
      ...requireRednoteWorkerCallbackIdentity(request),
      principal,
    });
    return rednoteJson(result);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'terminal_outcome',
      attemptId: params.id,
    });
  }
}
