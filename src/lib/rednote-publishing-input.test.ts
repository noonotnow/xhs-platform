import { createHash } from 'crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  canonicalRednoteAssetId,
  parseRednoteAttemptTransactionRequest,
  rednoteStableDigest,
  validateRednoteReceiptIdentity,
  validateRednoteAttemptSources,
  verifyRednoteAssetBytes,
} from '@/lib/rednote-publishing-input';

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const REVISION = '2026-08-07T15:00:00.000Z';
const REQUESTED_AT = '2026-08-07T16:00:00.000Z';
const MEDIA_URL =
  'https://images.xhs.justlikekatie.com/uploads/post.png';

function rawRequest(overrides: Record<string, unknown> = {}) {
  const payload = {
    contractRevision: 'rednote-publishing/v1',
    sourceNotionPageId: PAGE_ID,
    sourceLocalPublishJobId: JOB_ID,
    payloadRevision: 'rednote-browser-payload/v1',
    sourcePostRevision: REVISION,
    requestedAt: REQUESTED_AT,
    executor: {
      type: 'worker',
      kind: 'playwright',
      id: 'worker-1',
    },
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
      ...overrides,
    },
  };
  return {
    requestedBy: 'create',
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: {
      ...payload,
      payloadDigest: rednoteStableDigest(payload),
    },
  };
}

function refreshPayloadDigest(value: ReturnType<typeof rawRequest>) {
  const payload = Object.fromEntries(
    Object.entries(value.payload).filter(([key]) => key !== 'payloadDigest'),
  );
  value.payload.payloadDigest = rednoteStableDigest(payload);
}

describe('Rednote publishing input', () => {
  it('parses the exact frozen packet and preserves ordered source identity', () => {
    const request = parseRednoteAttemptTransactionRequest(rawRequest(), 'create');
    expect(request.payload.browserPayload.mediaAssets[0]).toMatchObject({
      assetId: 'uploads/post.png',
      deliveryUrl: MEDIA_URL,
      mimeType: 'image/png',
    });
    expect(request.payload.sourcePostRevision).toBe(REVISION);
  });

  it('rejects extra keys, requester spoofing, and changed payload digests', () => {
    expect(() => parseRednoteAttemptTransactionRequest({
      ...rawRequest(),
      unexpected: true,
    })).toThrow(/unexpected unexpected/);
    expect(() => parseRednoteAttemptTransactionRequest(
      rawRequest(),
      'plan',
    )).toThrow(/authenticated requester/);
    const changed = rawRequest();
    changed.payload.payloadDigest = 'f'.repeat(64);
    expect(() => parseRednoteAttemptTransactionRequest(changed))
      .toThrow(/payloadDigest/);
  });

  it('requires exact source identity, copy, order, timing, and local job linkage', () => {
    const request = parseRednoteAttemptTransactionRequest(rawRequest());
    const post = {
      id: PAGE_ID,
      lastEditedTime: REVISION,
      status: 'Ready',
      packetAuthorized: true,
      title: 'Frozen title',
      caption: 'Frozen caption',
      tags: ['one', 'two'],
      scheduledDate: null,
      mediaUrls: [MEDIA_URL],
    };
    const localJob = {
      id: JOB_ID,
      snapshot: {
        notionPageId: PAGE_ID,
        headline: 'Frozen title',
        title: 'Frozen title',
        caption: 'Frozen caption',
        tags: ['one', 'two'],
        platform: 'RedNote' as const,
        mediaType: 'image' as const,
        mediaIndex: 0,
        mediaUrl: MEDIA_URL,
        notionLastEditedTime: REVISION,
      },
    };
    expect(() => validateRednoteAttemptSources(request, post, localJob))
      .not.toThrow();
    expect(() => validateRednoteAttemptSources(
      request,
      { ...post, tags: ['two', 'one'] },
      localJob,
    )).toThrow(/ordered tags/);
    expect(() => validateRednoteAttemptSources(
      request,
      { ...post, packetAuthorized: false },
      localJob,
    )).toThrow(/not packet-authorized/);
    expect(() => validateRednoteAttemptSources(
      request,
      post,
      { ...localJob, id: '44444444-4444-4444-8444-444444444444' },
    )).toThrow(/local publish job/);
  });

  it('uses the exact canonical object key and rejects ambiguous URLs', () => {
    expect(canonicalRednoteAssetId(MEDIA_URL)).toBe('uploads/post.png');
    expect(() => canonicalRednoteAssetId(
      `${MEDIA_URL}?version=changed`,
    )).toThrow(/unambiguous/);
    expect(() => parseRednoteAttemptTransactionRequest(rawRequest({
      mediaAssets: [{
        assetId: 'invented-id',
        deliveryUrl: MEDIA_URL,
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        mediaType: 'image',
        role: 'content',
      }],
    }))).toThrow(/canonical R2 object key/);
  });

  it('rejects poster assets until Posts has an authoritative poster field', () => {
    expect(() => parseRednoteAttemptTransactionRequest(rawRequest({
      publishMode: 'video',
      mediaAssets: [{
        assetId: 'videos/assets/post.mp4',
        deliveryUrl:
          'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
        sha256: 'b'.repeat(64),
        mimeType: 'video/mp4',
        mediaType: 'video',
        role: 'content',
      }],
      posterAsset: {
        assetId: 'uploads/poster.png',
        deliveryUrl:
          'https://images.xhs.justlikekatie.com/uploads/poster.png',
        sha256: 'c'.repeat(64),
        mimeType: 'image/png',
        mediaType: 'image',
        role: 'poster',
      },
    }))).toThrow(/authoritative poster field/);
  });

  it('verifies MIME headers, decoded bytes, and SHA-256 independently', async () => {
    const bytes = new Uint8Array(await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: '#ff0000',
      },
    }).png().toBuffer());
    const requestValue = rawRequest();
    const browserPayload = requestValue.payload.browserPayload;
    browserPayload.mediaAssets[0].sha256 = createHash('sha256')
      .update(bytes)
      .digest('hex');
    refreshPayloadDigest(requestValue);
    const request = parseRednoteAttemptTransactionRequest(requestValue);

    await expect(verifyRednoteAssetBytes(
      request,
      async () => ({ bytes, contentType: 'image/png; charset=binary' }),
    )).resolves.toBeUndefined();
    await expect(verifyRednoteAssetBytes(
      request,
      async () => ({ bytes, contentType: 'image/jpeg' }),
    )).rejects.toThrow(/MIME header/);
    await expect(verifyRednoteAssetBytes(
      request,
      async () => ({
        bytes: new Uint8Array(Buffer.concat([bytes, Buffer.from([0])])),
        contentType: 'image/png',
      }),
    )).rejects.toThrow(/checksum/);
  });

  it('requires a structurally complete MP4 media track', async () => {
    const box = (type: string, ...parts: Uint8Array[]) => {
      const payload = Buffer.concat(parts);
      const result = Buffer.alloc(8 + payload.length);
      result.writeUInt32BE(result.length, 0);
      result.write(type, 4, 4, 'ascii');
      payload.copy(result, 8);
      return new Uint8Array(result);
    };
    const bytes = new Uint8Array(Buffer.concat([
      box('ftyp', Buffer.from('isom0000')),
      box('moov', box('trak', box(
        'mdia',
        box('hdlr', Buffer.concat([
          Buffer.alloc(8),
          Buffer.from('vide'),
        ])),
        box('minf'),
      ))),
      box('mdat', Buffer.from([1])),
    ]));
    const requestValue = rawRequest({
      publishMode: 'video',
      mediaAssets: [{
        assetId: 'videos/assets/post.mp4',
        deliveryUrl:
          'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'video/mp4',
        mediaType: 'video',
        role: 'content',
      }],
    });
    refreshPayloadDigest(requestValue);
    const request = parseRednoteAttemptTransactionRequest(requestValue);
    await expect(verifyRednoteAssetBytes(
      request,
      async () => ({ bytes, contentType: 'video/mp4' }),
    )).resolves.toBeUndefined();
    const emptyContainer = new Uint8Array(Buffer.concat([
      box('ftyp', Buffer.from('isom0000')),
      box('moov'),
      box('mdat'),
    ]));
    await expect(verifyRednoteAssetBytes(
      request,
      async () => ({ bytes: emptyContainer, contentType: 'video/mp4' }),
    )).rejects.toThrow(/structurally complete MP4/);

    const audioOnly = new Uint8Array(Buffer.concat([
      box('ftyp', Buffer.from('isom0000')),
      box('moov', box('trak', box(
        'mdia',
        box('hdlr', Buffer.concat([
          Buffer.alloc(8),
          Buffer.from('soun'),
        ])),
        box('minf'),
      ))),
      box('mdat', Buffer.from([1])),
    ]));
    const audioRequestValue = rawRequest({
      publishMode: 'video',
      mediaAssets: [{
        assetId: 'videos/assets/post.mp4',
        deliveryUrl:
          'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
        sha256: createHash('sha256').update(audioOnly).digest('hex'),
        mimeType: 'video/mp4',
        mediaType: 'video',
        role: 'content',
      }],
    });
    refreshPayloadDigest(audioRequestValue);
    await expect(verifyRednoteAssetBytes(
      parseRednoteAttemptTransactionRequest(audioRequestValue),
      async () => ({ bytes: audioOnly, contentType: 'video/mp4' }),
    )).rejects.toThrow(/structurally complete MP4/);
  });

  it('accepts only a canonical public receipt URL for the exact Note ID', () => {
    expect(validateRednoteReceiptIdentity({
      rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
      rednoteNoteId: 'note-1',
    })).toEqual({
      rednoteUrl: 'https://www.xiaohongshu.com/explore/note-1',
      rednoteNoteId: 'note-1',
    });
    expect(() => validateRednoteReceiptIdentity({
      rednoteUrl: 'https://www.xiaohongshu.com/search/note-1?token=secret',
      rednoteNoteId: 'note-1',
    })).toThrow(/platform receipt URL/);
  });

  it('requires scheduled and post-now timing to be internally coherent', () => {
    expect(() => parseRednoteAttemptTransactionRequest(rawRequest({
      targetPublishAt: '2026-08-08T16:00:00.000Z',
    }))).toThrow(/Post-now/);
    expect(() => parseRednoteAttemptTransactionRequest(rawRequest({
      scheduledDate: '2026-08-08T12:00:00.000-04:00',
    }))).toThrow(/future canonical schedule/);
    const scheduled = rawRequest({
      timingMode: 'scheduled',
      scheduledDate: '2026-08-08T12:00:00.000-04:00',
      targetPublishAt: '2026-08-08T16:00:00.000Z',
    });
    refreshPayloadDigest(scheduled);
    expect(() => parseRednoteAttemptTransactionRequest(scheduled)).not.toThrow();
  });
});
