import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteOutcomeBody,
  readRednoteJson,
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
    const principal = await requireRednoteAdmin(request);
    return rednoteJson(await recordRednoteTerminalOutcome({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      ...parseRednoteOutcomeBody(await readRednoteJson(request)),
      principal,
    }));
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'admin_terminal_outcome',
      attemptId: params.id,
    });
  }
}
