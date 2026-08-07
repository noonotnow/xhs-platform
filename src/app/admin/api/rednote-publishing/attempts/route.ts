import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  readRednoteJson,
  requireRednoteIdempotencyKey,
} from '@/lib/rednote-publishing-api';
import {
  rednoteErrorResponse,
  rednoteJson,
} from '@/lib/rednote-publishing-http';
import { createRednoteAttempt } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const principal = await requireRednoteAdmin(request);
    const idempotencyKey = requireRednoteIdempotencyKey(request);
    const result = await createRednoteAttempt({
      rawRequest: await readRednoteJson(request),
      idempotencyKey,
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, { requester: 'admin' });
  }
}
