import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compatibleCanonicalMovUrls,
  fetchCanonicalMovDescriptorVerdict,
  parseCanonicalMovAssetUrl,
} from '@/lib/media-descriptor';

const ASSET_ID = '7451b49c-9dd9-4100-9935-105e6ebaa39b';
const MOV_URL =
  `https://images.xhs.justlikekatie.com/videos/assets/74/${ASSET_ID}.mov`;

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    assetId: ASSET_ID,
    deliveryUrl: MOV_URL,
    mediaType: 'video',
    mimeType: 'video/quicktime',
    containerFormat: 'quicktime',
    processingState: 'ready',
    compatibility: {
      xhsPublishing: 'compatible',
      reason: null,
    },
    ...overrides,
  };
}

describe('MEDIA MOV descriptor consumer', () => {
  beforeEach(() => {
    process.env.MEDIA_API_BASE_URL = 'https://media.example.com/';
    process.env.MEDIA_ASSETS_READ_CREDENTIAL = 'service-credential';
    process.env.MEDIA_DESCRIPTOR_TIMEOUT_MS = '1250';
  });

  afterEach(() => {
    delete process.env.MEDIA_API_BASE_URL;
    delete process.env.MEDIA_ASSETS_READ_CREDENTIAL;
    delete process.env.MEDIA_DESCRIPTOR_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('parses asset IDs only from the exact canonical MOV URL shape', () => {
    expect(parseCanonicalMovAssetUrl(MOV_URL)).toEqual({
      assetId: ASSET_ID,
      canonicalUrl: MOV_URL,
    });
    expect(parseCanonicalMovAssetUrl(
      `https://images.xhs.justlikekatie.com/videos/assets/74/${ASSET_ID}.MOV`,
    )?.assetId).toBe(ASSET_ID);

    for (const url of [
      `http://images.xhs.justlikekatie.com/videos/assets/74/${ASSET_ID}.mov`,
      `https://images.xhs.justlikekatie.com:444/videos/assets/74/${ASSET_ID}.mov`,
      `https://images.xhs.justlikekatie.com/videos/assets/7/${ASSET_ID}.mov`,
      `https://images.xhs.justlikekatie.com/videos/assets/74/not-an-id.mov`,
      `${MOV_URL}?download=1`,
      `${MOV_URL}#fragment`,
      `https://example.com/videos/assets/74/${ASSET_ID}.mov`,
    ]) {
      expect(parseCanonicalMovAssetUrl(url)).toBeNull();
    }
  });

  it('uses the backend credential and accepts only the exact compatible verdict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      data: descriptor(),
    }));

    await expect(fetchCanonicalMovDescriptorVerdict(MOV_URL, fetchImpl))
      .resolves.toEqual({ compatible: true, assetId: ASSET_ID });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://media.example.com/v1/assets/${ASSET_ID}`,
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'service-credential',
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    ['assetId', { assetId: '6ca0927b-66ef-4a90-8c6d-39f9e6db903b' }, 'identity'],
    ['deliveryUrl', { deliveryUrl: `${MOV_URL}?changed=1` }, 'identity'],
    ['mediaType', { mediaType: 'image' }, 'verdict'],
    ['mimeType', { mimeType: 'video/mp4' }, 'verdict'],
    ['containerFormat', { containerFormat: 'mp4' }, 'verdict'],
    ['processingState', { processingState: 'pending_validation' }, 'verdict'],
    ['xhs verdict', {
      compatibility: { xhsPublishing: 'transcode-required', reason: null },
    }, 'verdict'],
    ['reason', {
      compatibility: { xhsPublishing: 'compatible', reason: 'codec-analysis-required' },
    }, 'verdict'],
  ])('fails closed on a %s mismatch', async (_label, override, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      data: descriptor(override),
    }));
    await expect(fetchCanonicalMovDescriptorVerdict(MOV_URL, fetchImpl))
      .resolves.toMatchObject({ compatible: false, code });
  });

  it('fails closed for configuration, auth, transport, timeout, and parse errors', async () => {
    delete process.env.MEDIA_ASSETS_READ_CREDENTIAL;
    await expect(fetchCanonicalMovDescriptorVerdict(MOV_URL, vi.fn()))
      .resolves.toMatchObject({ compatible: false, code: 'configuration' });

    process.env.MEDIA_ASSETS_READ_CREDENTIAL = 'service-credential';
    await expect(fetchCanonicalMovDescriptorVerdict(
      MOV_URL,
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    )).resolves.toMatchObject({ compatible: false, code: 'authentication' });
    await expect(fetchCanonicalMovDescriptorVerdict(
      MOV_URL,
      vi.fn().mockRejectedValue(new TypeError('network detail must not escape')),
    )).resolves.toMatchObject({ compatible: false, code: 'fetch' });
    await expect(fetchCanonicalMovDescriptorVerdict(
      MOV_URL,
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    )).resolves.toMatchObject({ compatible: false, code: 'timeout' });
    await expect(fetchCanonicalMovDescriptorVerdict(
      MOV_URL,
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })),
    )).resolves.toMatchObject({ compatible: false, code: 'parse' });
  });

  it('deduplicates descriptor reads and returns only compatible URLs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: descriptor() }));
    await expect(compatibleCanonicalMovUrls(
      [MOV_URL, MOV_URL, 'https://images.xhs.justlikekatie.com/videos/assets/trial.mov'],
      { requestId: 'request-id', fetchImpl },
    )).resolves.toEqual(new Set([MOV_URL]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
