import { getReadyXhsPost } from '@/lib/notion-posts';
import {
  parseManualSchedulingAttestationInput,
} from '@/lib/manual-scheduling-attestation-input';
import {
  insertManualSchedulingAttestation,
  loadManualSchedulingAttestationReplay,
} from '@/lib/manual-scheduling-attestation-store';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { buildBatchSnapshot, manifestHash } from '@/lib/rednote-publish-batches';

export async function createManualSchedulingAttestation(
  rawInput: unknown,
  idempotencyKey: string,
  actor: string,
) {
  const input = parseManualSchedulingAttestationInput(rawInput);
  const replay = await loadManualSchedulingAttestationReplay(
    input,
    idempotencyKey,
    actor,
  );
  if (replay) {
    return replay;
  }
  const post = await getReadyXhsPost(input.notionPageId);
  const currentSnapshot = buildBatchSnapshot(post);
  if (
    !currentSnapshot ||
    currentSnapshot.notionLastEditedTime !== input.snapshotRevision ||
    currentSnapshot.publishAt !== input.requestedPublishAt ||
    manifestHash(currentSnapshot) !== input.itemHash
  ) {
    throw new LocalPublishJobError(
      'The Notion post changed after this packet was frozen; refresh before asserting scheduling',
      'MANUAL_SCHEDULING_STALE_REVISION',
      409,
    );
  }
  return insertManualSchedulingAttestation(input, idempotencyKey, actor);
}
