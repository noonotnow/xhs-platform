import { requireRednoteWorker } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteReceiptLookupBody,
  readRednoteJson,
  requireRednoteWorkerCallbackIdentity,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { advanceRednoteReceiptLookup } from '@/lib/rednote-publishing';

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
    const result = await advanceRednoteReceiptLookup({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      ...parseRednoteReceiptLookupBody(await readRednoteJson(request)),
      ...requireRednoteWorkerCallbackIdentity(request),
      principal,
    });
    return rednoteJson(result);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'receipt_lookup',
      attemptId: params.id,
    });
  }
}
