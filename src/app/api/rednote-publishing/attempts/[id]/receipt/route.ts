import { requireRednoteWorker } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteReceiptBody,
  readRednoteJson,
  requireRednoteWorkerCallbackIdentity,
  requireRednoteUuid,
} from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { captureRednoteReceipt } from '@/lib/rednote-publishing';

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
    const attemptId = requireRednoteUuid(params.id, 'attemptId');
    const result = await captureRednoteReceipt({
      receipt: parseRednoteReceiptBody(await readRednoteJson(request), attemptId),
      ...requireRednoteWorkerCallbackIdentity(request),
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'receipt_capture',
      attemptId: params.id,
    });
  }
}
