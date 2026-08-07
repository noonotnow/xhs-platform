import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RednotePostProjectionError } from '@/lib/rednote-publishing-notion';

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  load: vi.fn(),
  complete: vi.fn(),
  conflict: vi.fn(),
  failure: vi.fn(),
  pending: vi.fn(),
  lock: vi.fn(async (
    _pageId: string,
    action: () => Promise<unknown>,
  ) => action()),
}));

vi.mock('@/lib/rednote-publishing-notion', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/rednote-publishing-notion')>();
  return {
    ...original,
    defaultRednoteNotionProjectionAdapter: vi.fn(() => ({
      read: vi.fn(),
      update: vi.fn(),
    })),
    projectRednotePostMutation: mocks.project,
  };
});

vi.mock('@/lib/rednote-publishing-store', () => ({
  completeRednotePostMutation: mocks.complete,
  conflictRednotePostMutation: mocks.conflict,
  listPendingRednotePostMutations: mocks.pending,
  loadRednotePostMutation: mocks.load,
  recordRednotePostMutationFailure: mocks.failure,
  withRednotePostProjectionLock: mocks.lock,
}));

import { reconcileRednotePostMutation } from '@/lib/rednote-publishing';

const mutation = {
  id: '33333333-3333-4333-8333-333333333333',
  attemptId: '22222222-2222-4222-8222-222222222222',
  sourceNotionPageId: '11111111-1111-4111-8111-111111111111',
  kind: 'worker_claim',
  expected: {
    activeAttemptId: null,
    status: 'Ready',
    nextAction: 'Ready for publication',
    publishExecution: 'Not attempted',
  },
  desired: {
    activeAttemptId: '22222222-2222-4222-8222-222222222222',
    status: 'Ready',
    nextAction: 'Resolve attempt',
    publishExecution: 'Worker claimed',
  },
  state: 'pending',
  diagnostics: {},
  createdAt: '2026-08-07T16:00:00.000Z',
} as const;

describe('Rednote Posts reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue(mutation);
    mocks.complete.mockResolvedValue({
      mutation: { ...mutation, state: 'applied' },
    });
    mocks.conflict.mockResolvedValue({
      ...mutation,
      state: 'conflict',
    });
  });

  it('finalizes durable state only after the Posts bundle verifies', async () => {
    mocks.project.mockResolvedValue({ outcome: 'verified' });
    await expect(reconcileRednotePostMutation(mutation.id, {
      now: () => new Date('2026-08-07T16:05:00.000Z'),
    })).resolves.toMatchObject({ state: 'applied' });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      mutationId: mutation.id,
      appliedAt: '2026-08-07T16:05:00.000Z',
    }));
    expect(mocks.conflict).not.toHaveBeenCalled();
  });

  it('quarantines a compare conflict without attempting finalization', async () => {
    mocks.project.mockResolvedValue({
      outcome: 'conflict',
      observed: {
        activeAttemptId: null,
        sourcePostRevision: '2026-08-07T16:04:00.000Z',
        status: 'Draft',
        nextAction: 'Develop packet',
        publishExecution: 'Not attempted',
      },
    });
    await expect(reconcileRednotePostMutation(mutation.id, {
      now: () => new Date('2026-08-07T16:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'REDNOTE_POST_CAS_CONFLICT',
      status: 409,
    });
    expect(mocks.conflict).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.failure).not.toHaveBeenCalled();
  });

  it('keeps unavailable Notion work pending with bounded diagnostics', async () => {
    mocks.project.mockRejectedValue(new RednotePostProjectionError(
      'Notion is temporarily unavailable',
      'REDNOTE_NOTION_UNAVAILABLE',
    ));
    await expect(reconcileRednotePostMutation(mutation.id, {
      now: () => new Date('2026-08-07T16:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'REDNOTE_NOTION_UNAVAILABLE',
      status: 503,
    });
    expect(mocks.failure).toHaveBeenCalledWith(expect.objectContaining({
      mutationId: mutation.id,
      code: 'REDNOTE_NOTION_UNAVAILABLE',
      message: 'Notion is temporarily unavailable',
    }));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('durably quarantines permanent projection errors', async () => {
    mocks.project.mockRejectedValue(new RednotePostProjectionError(
      'Posts contains a non-canonical execution value',
      'REDNOTE_NOTION_STATE_INVALID',
      409,
    ));
    await expect(reconcileRednotePostMutation(mutation.id, {
      now: () => new Date('2026-08-07T16:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'REDNOTE_NOTION_STATE_INVALID',
      status: 409,
    });
    expect(mocks.conflict).toHaveBeenCalledWith(expect.objectContaining({
      mutationId: mutation.id,
      code: 'REDNOTE_NOTION_STATE_INVALID',
    }));
    expect(mocks.failure).not.toHaveBeenCalled();
  });
});
