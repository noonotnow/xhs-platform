import { afterEach, describe, expect, it, vi } from 'vitest';
import { rednoteStableDigest } from '@/lib/rednote-publishing-input';

const store = vi.hoisted(() => ({
  create: vi.fn(),
  loadDetail: vi.fn(),
  replayClaim: vi.fn(),
  supersede: vi.fn(),
  transfer: vi.fn(),
}));

vi.mock('@/lib/rednote-publishing-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/rednote-publishing-store')>(),
  createStoredRednoteAttempt: store.create,
  loadRednoteAttemptDetail: store.loadDetail,
  replayStoredRednoteWorkerClaim: store.replayClaim,
  supersedeStoredRednoteAttempt: store.supersede,
  transferStoredRednoteOperatorResolution: store.transfer,
}));

import {
  claimRednoteAttempt,
  createRednoteAttempt,
  supersedeRednoteAttempt,
  transferRednoteOperatorResolution,
} from '@/lib/rednote-publishing';

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const REVISION = '2026-08-07T15:00:00.000Z';
const REQUESTED_AT = '2026-08-07T16:00:00.000Z';
const MEDIA_URL = 'https://images.xhs.justlikekatie.com/uploads/post.png';

function request() {
  const payload = {
    contractRevision: 'rednote-publishing/v1',
    sourceNotionPageId: PAGE_ID,
    sourceLocalPublishJobId: JOB_ID,
    payloadRevision: 'rednote-browser-payload/v1',
    sourcePostRevision: REVISION,
    requestedAt: REQUESTED_AT,
    executor: { type: 'worker', kind: 'playwright', id: 'worker-1' },
    browserPayload: {
      sourcePostId: PAGE_ID.replaceAll('-', ''),
      title: 'Frozen title',
      caption: 'Frozen caption',
      tags: ['one', 'two'],
      scheduledDate: null,
      targetPublishAt: REQUESTED_AT,
      timingMode: 'post_now',
      visibility: 'public',
      publishMode: 'image',
      mediaAssets: [{
        assetId: 'uploads/post.png',
        deliveryUrl: MEDIA_URL,
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        mediaType: 'image',
        role: 'content',
      }],
    },
  };
  return {
    requestedBy: 'create',
    idempotencyKey: KEY,
    payload: { ...payload, payloadDigest: rednoteStableDigest(payload) },
  };
}

function adminRequest() {
  const value = request();
  const payload = {
    ...value.payload,
    executor: {
      type: 'operator',
      kind: 'operator',
      id: 'operator@example.com',
    },
  };
  const unsigned = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'payloadDigest'),
  );
  return {
    requestedBy: 'admin',
    idempotencyKey: KEY,
    payload: {
      ...payload,
      payloadDigest: rednoteStableDigest(unsigned),
    },
  };
}

describe('Rednote control-plane orchestration', () => {
  afterEach(() => {
    delete process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION;
    vi.clearAllMocks();
  });

  it('validates authoritative Posts, local job, and asset bytes for a new key', async () => {
    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1';
    store.create.mockImplementation(async (input) => {
      await input.validateNew();
      return { attempt: { id: 'attempt-1' }, created: true };
    });
    const verifyAssets = vi.fn().mockResolvedValue(undefined);
    const result = await createRednoteAttempt({
      rawRequest: request(),
      idempotencyKey: KEY,
      principal: { requester: 'create', actorId: 'create-integration' },
      dependencies: {
        verifyAssets,
        loadPost: async () => ({
          id: PAGE_ID,
          pageUrl: `https://notion.so/${PAGE_ID}`,
          headline: 'Frozen title',
          caption: 'Frozen caption',
          status: 'Ready',
          publishPacketReady: true,
          hasVideo: false,
          needsMedia: false,
          needsCaption: false,
          mediaUrls: [MEDIA_URL],
          imageUrls: [MEDIA_URL],
          videoUrls: [],
          thumbnailUrl: '',
          tags: ['one', 'two'],
          scheduledDate: null,
          lastEditedTime: REVISION,
          automationBlockers: [],
          manualWarnings: [],
          publishBlockers: [],
          candidateKind: 'packet_ready',
        }),
        loadLocalJob: async () => ({
          id: JOB_ID,
          notionPageId: PAGE_ID,
          status: 'queued',
          snapshot: {
            notionPageId: PAGE_ID,
            headline: 'Frozen title',
            title: 'Frozen title',
            caption: 'Frozen caption',
            tags: ['one', 'two'],
            platform: 'RedNote',
            mediaType: 'image',
            mediaIndex: 0,
            mediaUrl: MEDIA_URL,
            notionLastEditedTime: REVISION,
          },
          createdAt: REQUESTED_AT,
          updatedAt: REQUESTED_AT,
          verificationAttempts: 0,
        }),
      },
    });
    expect(result).toMatchObject({ created: true });
    expect(verifyAssets).toHaveBeenCalledOnce();
  });

  it('rejects requester spoofing before durable creation', async () => {
    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1';
    await expect(createRednoteAttempt({
      rawRequest: request(),
      idempotencyKey: KEY,
      principal: { requester: 'plan', actorId: 'plan-integration' },
    })).rejects.toMatchObject({
      code: 'REDNOTE_REQUESTER_MISMATCH',
      status: 403,
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('rejects standalone operator creation', async () => {
    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1';
    await expect(createRednoteAttempt({
      rawRequest: adminRequest(),
      idempotencyKey: KEY,
      principal: {
        requester: 'admin',
        actorId: 'operator@example.com',
      },
    })).rejects.toMatchObject({
      code: 'REDNOTE_OPERATOR_TRANSACTION_REQUIRED',
      status: 409,
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('returns an exact committed claim replay while starts are disabled', async () => {
    store.replayClaim.mockResolvedValue(true);
    store.loadDetail.mockResolvedValue({
      attempt: { id: PAGE_ID, active: true },
      events: [],
      receipt: null,
      mutations: [],
    });
    await expect(claimRednoteAttempt({
      attemptId: PAGE_ID,
      expectedActiveAttemptId: null,
      workerRunId: 'worker-run-1',
      playwrightRunId: 'playwright-run-1',
      occurredAt: REQUESTED_AT,
      principal: {
        requester: 'worker',
        actorId: 'local-publish-worker',
      },
    })).resolves.toMatchObject({
      attempt: { id: PAGE_ID, active: true },
    });
    expect(store.loadDetail).toHaveBeenCalledWith(PAGE_ID, undefined);
  });

  it('binds supersession and transfer idempotency to the full operation', async () => {
    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1';
    store.supersede.mockResolvedValue({
      priorAttempt: { id: 'prior' },
      operatorAttempt: { id: 'next' },
      created: false,
    });
    store.transfer.mockResolvedValue({
      priorOperatorAttempt: { id: 'prior' },
      operatorAttempt: { id: 'next' },
      created: false,
    });
    const notion = {
      read: vi.fn(),
      update: vi.fn(),
    };
    const principal = {
      requester: 'admin' as const,
      actorId: 'operator@example.com',
    };
    await supersedeRednoteAttempt({
      priorAttemptId: PAGE_ID,
      rawRequest: adminRequest(),
      idempotencyKey: KEY,
      expectedActiveAttemptId: PAGE_ID,
      occurredAt: REQUESTED_AT,
      principal,
      dependencies: { notion },
    });
    await supersedeRednoteAttempt({
      priorAttemptId: PAGE_ID,
      rawRequest: adminRequest(),
      idempotencyKey: KEY,
      expectedActiveAttemptId: JOB_ID,
      occurredAt: REQUESTED_AT,
      principal,
      dependencies: { notion },
    });
    expect(store.supersede.mock.calls[0][0].rawRequestDigest)
      .not.toBe(store.supersede.mock.calls[1][0].rawRequestDigest);

    await transferRednoteOperatorResolution({
      priorOperatorAttemptId: PAGE_ID,
      rawRequest: adminRequest(),
      idempotencyKey: KEY,
      occurredAt: REQUESTED_AT,
      reason: 'first reason',
      principal,
      dependencies: { notion },
    });
    await transferRednoteOperatorResolution({
      priorOperatorAttemptId: PAGE_ID,
      rawRequest: adminRequest(),
      idempotencyKey: KEY,
      occurredAt: REQUESTED_AT,
      reason: 'changed reason',
      principal,
      dependencies: { notion },
    });
    expect(store.transfer.mock.calls[0][0].rawRequestDigest)
      .not.toBe(store.transfer.mock.calls[1][0].rawRequestDigest);
  });
});
