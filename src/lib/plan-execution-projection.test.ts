import { describe, expect, it } from 'vitest';
import type { LocalPublishJobSummary, PublishBatch } from '@/types/local-publish-job';
import { projectPlanExecution } from '@/lib/plan-execution-projection';

function job(values: Partial<LocalPublishJobSummary> = {}): LocalPublishJobSummary {
  return {
    id: 'job-1',
    notionPageId: 'page-1',
    status: 'queued',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    verificationAttempts: 0,
    ...values,
  };
}

const recovery = {
  recoveryKind: 'standard' as const,
  batchId: 'batch-1',
  manifestHash: 'manifest-1',
  itemId: 'item-1',
  jobId: 'job-1',
  itemHash: 'item-hash-1',
  snapshotRevision: 'revision-1',
  priorErrorCode: 'SCHEDULE_READBACK_MISMATCH' as const,
  claimAttempts: 1,
};

function batches(): PublishBatch[] {
  return [{
    id: 'batch-1',
    workspaceId: 'workspace-1',
    kind: 'bootstrap',
    status: 'approved',
    manifestHash: 'manifest-1',
    createdAt: '2026-09-12T09:00:00.000Z',
    items: [{
      id: 'item-1',
      notionPageId: 'page-1',
      snapshot: {} as PublishBatch['items'][number]['snapshot'],
      itemHash: 'item-hash-1',
      state: 'failed',
      dispatchMode: 'scheduled',
      lateBySeconds: 0,
      localPublishJobId: 'job-1',
      recoveryEvidence: recovery,
    }],
    blockedCandidates: [],
  }];
}

describe('PLAN execution projection', () => {
  it('reports no attempt without inventing worker state', () => {
    expect(projectPlanExecution('page-1', [], [])).toMatchObject({
      state: 'no_attempt', retryEligible: false, publicationRuledOut: true,
    });
  });

  it('projects recoverability only from durable recovery evidence', () => {
    expect(projectPlanExecution('page-1', [job({
      status: 'failed',
      errorCode: 'SCHEDULE_READBACK_MISMATCH',
    })], batches())).toMatchObject({
      state: 'failed_recoverable_pre_publish',
      retryEligible: true,
      publicationRuledOut: true,
      recoveryEvidence: recovery,
    });
  });

  it('fails closed for a failed job without recovery evidence', () => {
    expect(projectPlanExecution('page-1', [job({ status: 'failed' })], [])).toMatchObject({
      state: 'failed_not_recoverable', retryEligible: false, publicationRuledOut: false,
    });
  });

  it.each(['submitted', 'scheduled', 'operator_attested', 'verification_pending', 'verified'] as const)(
    'treats %s as receipt pending and never retryable',
    (status) => {
      expect(projectPlanExecution('page-1', [job({ status })], [])).toMatchObject({
        state: 'receipt_pending', retryEligible: false, publicationRuledOut: false,
      });
    },
  );

  it('preserves reconciled publication truth', () => {
    expect(projectPlanExecution('page-1', [job({
      status: 'reconciled',
      noteId: 'note-1',
      shareUrl: 'https://www.rednote.com/explore/note-1',
    })], [])).toMatchObject({
      state: 'published', retryEligible: false, publicationRuledOut: false,
      noteId: 'note-1',
    });
  });
});
