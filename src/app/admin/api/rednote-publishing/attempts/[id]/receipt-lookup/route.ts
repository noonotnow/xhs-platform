import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import {
  parseRednoteReceiptLookupBody,
  readRednoteJson,
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
    const principal = await requireRednoteAdmin(request);
    const result = await advanceRednoteReceiptLookup({
      attemptId: requireRednoteUuid(params.id, 'attemptId'),
      ...parseRednoteReceiptLookupBody(await readRednoteJson(request)),
      principal,
    });
    return rednoteJson(result);
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'admin_receipt_lookup',
      attemptId: params.id,
    });
  }
}
