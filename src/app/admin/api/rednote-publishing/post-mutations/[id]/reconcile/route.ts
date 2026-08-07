import { requireRednoteAdmin } from '@/lib/rednote-publishing-auth';
import { requireRednoteUuid } from '@/lib/rednote-publishing-api';
import { rednoteErrorResponse, rednoteJson } from '@/lib/rednote-publishing-http';
import { reconcileRednotePostMutation } from '@/lib/rednote-publishing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    await requireRednoteAdmin(request);
    return rednoteJson(
      await reconcileRednotePostMutation(
        requireRednoteUuid(params.id, 'mutationId'),
      ),
    );
  } catch (error) {
    return rednoteErrorResponse(error, {
      operation: 'reconcile_projection',
      mutationId: params.id,
    });
  }
}
