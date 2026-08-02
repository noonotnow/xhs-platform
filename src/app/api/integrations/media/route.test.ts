import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMediaPreflight,
  handleMediaUpload,
} from '@/lib/integration-media';

const ALLOWED_ORIGIN = 'https://fandom.justlikekatie.com';
const PLAN_SECRET = 'a-secure-plan-integration-secret-123';
const PUBLIC_URL = 'https://images.xhs.justlikekatie.com';
const RAW_R2_PUBLIC_URL =
  'https://pub-33313e22c1be49a8b4bf97c791caf646.r2.dev';

function validImage(format: 'jpeg' | 'png' | 'webp') {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 210, g: 40, b: 120, alpha: 1 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

function imageRequest(
  bytes: number[] | Uint8Array,
  type = 'image/png',
  options: {
    authorization?: string;
    origin?: string;
    fieldName?: string;
  } = {}
) {
  const formData = new FormData();
  formData.append(
    options.fieldName ?? 'file',
    new Blob([new Uint8Array(bytes)], { type }),
    'share-card'
  );

  return new Request('https://xhs.justlikekatie.com/api/integrations/media', {
    method: 'POST',
    headers: {
      Authorization: options.authorization ?? `Bearer ${PLAN_SECRET}`,
      Origin: options.origin ?? ALLOWED_ORIGIN,
    },
    body: formData,
  });
}

describe('/api/integrations/media', () => {
  beforeEach(() => {
    vi.stubEnv('PLAN_SECRET', PLAN_SECRET);
    vi.stubEnv('R2_PUBLIC_URL', PUBLIC_URL);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['missing', ''],
    ['invalid', 'Bearer wrong-secret'],
  ])('rejects %s Bearer authentication', async (_case, authorization) => {
    const upload = vi.fn();
    const response = await handleMediaUpload(
      imageRequest(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        'image/png',
        { authorization }
      ),
      upload
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Missing or invalid Bearer integration secret.',
    });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(upload).not.toHaveBeenCalled();
  });

  it('allows preflight only from the Vibe Atlas origin', async () => {
    const allowed = await handleMediaPreflight(
      new Request('https://xhs.justlikekatie.com/api/integrations/media', {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN },
      })
    );
    const denied = await handleMediaPreflight(
      new Request('https://xhs.justlikekatie.com/api/integrations/media', {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      })
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(allowed.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type'
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('rejects POST requests from other browser origins', async () => {
    const upload = vi.fn();
    const response = await handleMediaUpload(
      imageRequest(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        'image/png',
        { origin: 'https://example.com' }
      ),
      upload
    );

    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a missing file field',
      request: () =>
        imageRequest(
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          'image/png',
          { fieldName: 'image' }
        ),
      status: 400,
    },
    {
      name: 'an unsupported media type',
      request: () => imageRequest([0x47, 0x49, 0x46], 'image/gif'),
      status: 415,
    },
    {
      name: 'a mismatched file type',
      request: () => imageRequest([0x47, 0x49, 0x46], 'image/png'),
      status: 415,
    },
    {
      name: 'a truncated PNG',
      request: () =>
        imageRequest(
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          'image/png'
        ),
      status: 415,
    },
  ])('rejects $name', async ({ request, status }) => {
    const upload = vi.fn();
    const response = await handleMediaUpload(request(), upload);

    expect(response.status).toBe(status);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects files larger than 4 MB', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = vi.fn();
    const response = await handleMediaUpload(
      imageRequest(oversized),
      upload
    );

    expect(response.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects PNG files containing APNG animation control', async () => {
    const png = await validImage('png');
    const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
    const animationControl = Buffer.alloc(20);
    animationControl.writeUInt32BE(8, 0);
    animationControl.write('acTL', 4, 'ascii');
    animationControl.writeUInt32BE(2, 8);
    const animatedPng = Buffer.concat([
      png.subarray(0, ihdrEnd),
      animationControl,
      png.subarray(ihdrEnd),
    ]);
    const upload = vi.fn();
    const response = await handleMediaUpload(imageRequest(animatedPng), upload);

    expect(response.status).toBe(415);
    expect(console.warn).toHaveBeenCalledWith(
      '[integration media] Image decode validation failed',
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Animated PNG images are not supported',
        }),
      })
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('rewrites a configured raw R2 upload URL to the canonical CDN host', async () => {
    const bytes = await validImage('png');
    const rawUrl = `${RAW_R2_PUBLIC_URL}/uploads/share-card.png`;
    const canonicalUrl = `${PUBLIC_URL}/uploads/share-card.png`;
    vi.stubEnv('R2_PUBLIC_URL', RAW_R2_PUBLIC_URL);
    const upload = vi.fn().mockResolvedValue(rawUrl);
    const response = await handleMediaUpload(imageRequest(bytes), upload);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ url: canonicalUrl });
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(upload).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledWith(
      bytes,
      'image/png',
      'png'
    );
  });

  it('keeps a canonical R2 upload URL canonical', async () => {
    const bytes = await validImage('png');
    const url = `${PUBLIC_URL}/uploads/share-card.png`;
    const upload = vi.fn().mockResolvedValue(url);
    const response = await handleMediaUpload(imageRequest(bytes), upload);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ url });
  });

  it('rejects an upload URL from outside the configured R2 public origin', async () => {
    const bytes = await validImage('png');
    vi.stubEnv('R2_PUBLIC_URL', RAW_R2_PUBLIC_URL);
    const upload = vi
      .fn()
      .mockResolvedValue('https://example.com/uploads/share-card.png');
    const response = await handleMediaUpload(imageRequest(bytes), upload);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Media storage returned an invalid public URL.',
    });
    expect(console.error).toHaveBeenCalledWith(
      '[integration media] R2 returned a URL outside R2_PUBLIC_URL',
      { url: 'https://example.com/uploads/share-card.png' }
    );
  });

  it.each([
    {
      contentType: 'image/jpeg',
      extension: 'jpg',
      format: 'jpeg' as const,
    },
    {
      contentType: 'image/webp',
      extension: 'webp',
      format: 'webp' as const,
    },
  ])(
    'accepts decoded $contentType content',
    async ({ contentType, extension, format }) => {
      const bytes = await validImage(format);
      const upload = vi
        .fn()
        .mockResolvedValue(`${PUBLIC_URL}/uploads/share-card.${extension}`);
      const response = await handleMediaUpload(
        imageRequest(bytes, contentType),
        upload
      );

      expect(response.status).toBe(201);
      expect(upload).toHaveBeenCalledWith(
        Buffer.from(bytes),
        contentType,
        extension
      );
    }
  );

  it('returns an actionable error when the R2 upload fails', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('R2 unavailable'));
    const image = await validImage('png');
    const response = await handleMediaUpload(
      imageRequest(image),
      upload
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error:
        'Media upload failed. Retry the request; contact the XHS platform operator if it persists.',
    });
    expect(console.error).toHaveBeenCalledWith(
      '[integration media] R2 upload failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
