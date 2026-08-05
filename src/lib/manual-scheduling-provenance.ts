import type { OperatorSuccessAttestationSummary } from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

export type ManualSchedulingProvenanceMismatch =
  | 'scheduled_date_removed'
  | 'scheduled_date_changed'
  | 'post_revision_changed';

export function manualSchedulingProvenanceMismatch(
  post: ReadyXhsPost,
  attestation: OperatorSuccessAttestationSummary | undefined,
): ManualSchedulingProvenanceMismatch | null {
  if (!attestation || attestation.provenance !== 'manual_scheduled') {
    return null;
  }
  if (!post.publishAt) {
    return 'scheduled_date_removed';
  }
  if (post.publishAt !== attestation.requestedPublishAt) {
    return 'scheduled_date_changed';
  }
  if (post.lastEditedTime !== attestation.snapshotRevision) {
    return 'post_revision_changed';
  }
  return null;
}
