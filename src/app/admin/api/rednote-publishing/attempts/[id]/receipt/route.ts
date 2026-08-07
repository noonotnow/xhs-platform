import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteReceiptBody,
  readRednoteJson,
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
    const principal = await requireRednoteAdmin(request);
    const attemptId = requireRednoteUuid(params.id, 'attemptId');
    const result = await captureRednoteReceipt({
      receipt: parseRednoteReceiptBody(await readRednoteJson(request), attemptId),
      principal,
    });
    return rednoteJson(result, result.created ? 201 : 200);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'admin_receipt_capture',
      attemptId: params.id,
    });
  }
}
