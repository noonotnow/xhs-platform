import { describe, expect, it } from 'vitest';
import { manualSchedulingProvenanceMismatch } from '@/lib/manual-scheduling-provenance';
import type { OperatorSuccessAttestationSummary } from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

const publishAt = '2026-08-06T14:30:00.000Z';
const revision = '2026-08-04T13:12:00.000Z';
const post = {
  publishAt,
  lastEditedTime: revision,
} as ReadyXhsPost;
const attestation = {
  provenance: 'manual_scheduled',
  requestedPublishAt: publishAt,
  snapshotRevision: revision,
} as OperatorSuccessAttestationSummary;

describe('manual scheduling provenance', () => {
  it('matches only the exact current ScheduledDate and Post revision', () => {
    expect(manualSchedulingProvenanceMismatch(post, attestation)).toBeNull();
    expect(manualSchedulingProvenanceMismatch(
      { ...post, publishAt: undefined },
      attestation,
    )).toBe('scheduled_date_removed');
    expect(manualSchedulingProvenanceMismatch(
      { ...post, publishAt: '2026-08-06T15:30:00.000Z' },
      attestation,
    )).toBe('scheduled_date_changed');
    expect(manualSchedulingProvenanceMismatch(
      { ...post, lastEditedTime: '2026-08-05T13:12:00.000Z' },
      attestation,
    )).toBe('post_revision_changed');
  });
});
