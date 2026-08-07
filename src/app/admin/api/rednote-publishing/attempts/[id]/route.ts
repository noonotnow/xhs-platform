import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import { requireRednoteUuid } from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { getRednoteAttempt } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    await requireRednoteAdmin(request);
    return rednoteJson(
      await getRednoteAttempt(requireRednoteUuid(params.id, 'attemptId')),
    );
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'attempt_detail',
      attemptId: params.id,
    });
  }
}
