import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { uploadToR2 } from '@/lib/r2';

const ALLOWED_ORIGIN = 'https://fandom.justlikekatie.com';
const CANONICAL_MEDIA_ORIGIN = 'https://images.xhs.justlikekatie.com';
const ALLOWED_TYPES = {
  'image/jpeg': { extension: 'jpg', format: 'jpeg' },
  'image/png': { extension: 'png', format: 'png' },
  'image/webp': { extension: 'webp', format: 'webp' },
} as const;
const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_777_216;
const MIN_SECRET_LENGTH = 32;

type AllowedContentType = keyof typeof ALLOWED_TYPES;
type UploadMedia = (
  file: Buffer,
  contentType: string,
  extension: string
) => Promise<string>;
type HeaderRecord = Record<string, string>;

function corsHeaders(origin: string | null): HeaderRecord {
  if (origin !== ALLOWED_ORIGIN) return {};

  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function errorResponse(
  error: string,
  status: number,
  origin: string | null,
  headers: HeaderRecord = {}
) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        ...corsHeaders(origin),
        ...headers,
      },
    }
  );
}

function isAuthorized(authHeader: string | null, secret: string): boolean {
  const provided = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const providedDigest = createHash('sha256')
    .update(provided ?? '', 'utf8')
    .digest();
  const expectedDigest = createHash('sha256').update(secret, 'utf8').digest();

  return provided !== null && timingSafeEqual(providedDigest, expectedDigest);
}

function hasExpectedSignature(buffer: Buffer, contentType: AllowedContentType) {
  if (contentType === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    );
  }

  if (contentType === 'image/jpeg') {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function isAnimatedPng(buffer: Buffer) {
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const dataLength = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const chunkEnd = typeStart + 4 + dataLength + 4;
    if (chunkEnd > buffer.length) return false;

    const chunkType = buffer.subarray(typeStart, typeStart + 4).toString('ascii');
    if (chunkType === 'acTL') return true;
    if (chunkType === 'IEND') return false;

    offset = chunkEnd;
  }

  return false;
}

async function validateImage(buffer: Buffer, contentType: AllowedContentType) {
  if (!hasExpectedSignature(buffer, contentType)) {
    throw new Error('Image signature does not match its Content-Type');
  }

  if (contentType === 'image/png' && isAnimatedPng(buffer)) {
    throw new Error('Animated PNG images are not supported');
  }

  const image = sharp(buffer, {
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await image.metadata();

  if (
    metadata.format !== ALLOWED_TYPES[contentType].format ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error('Decoded image format does not match its Content-Type');
  }

  if ((metadata.pages ?? 1) > 1) {
    throw new Error('Animated images are not supported');
  }

  await image.clone().raw().toBuffer();
}

function canonicalizePublicR2Url(
  url: string,
  publicBase: string
): string | null {
  try {
    const uploadedUrl = new URL(url);
    const publicUrl = new URL(publicBase);
    const publicPath = publicUrl.pathname.replace(/\/$/, '');

    const isConfiguredPublicUrl =
      uploadedUrl.protocol === 'https:' &&
      uploadedUrl.origin === publicUrl.origin &&
      uploadedUrl.pathname.startsWith(`${publicPath}/`);
    if (!isConfiguredPublicUrl) return null;

    return new URL(
      `${uploadedUrl.pathname}${uploadedUrl.search}${uploadedUrl.hash}`,
      CANONICAL_MEDIA_ORIGIN
    ).toString();
  } catch {
    return null;
  }
}

export function handleMediaPreflight(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== ALLOWED_ORIGIN) {
    console.warn('[integration media] Rejected preflight from unauthorized origin', {
      origin,
    });
    return errorResponse(
      `CORS origin is not allowed. Expected ${ALLOWED_ORIGIN}.`,
      403,
      origin
    );
  }

  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export async function handleMediaUpload(
  request: Request,
  upload: UploadMedia = uploadToR2
) {
  const origin = request.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    console.warn('[integration media] Rejected upload from unauthorized origin', {
      origin,
    });
    return errorResponse(
      `CORS origin is not allowed. Expected ${ALLOWED_ORIGIN}.`,
      403,
      origin
    );
  }

  const integrationSecret = process.env.PLAN_SECRET;
  if (!integrationSecret || integrationSecret.length < MIN_SECRET_LENGTH) {
    console.error(
      `[integration media] PLAN_SECRET must be configured with at least ${MIN_SECRET_LENGTH} characters`
    );
    return errorResponse(
      'Media upload integration is not configured. Set a PLAN_SECRET of at least 32 characters.',
      500,
      origin
    );
  }

  if (!isAuthorized(request.headers.get('authorization'), integrationSecret)) {
    console.warn('[integration media] Rejected upload with invalid Bearer credentials');
    return errorResponse(
      'Missing or invalid Bearer integration secret.',
      401,
      origin,
      { 'WWW-Authenticate': 'Bearer' }
    );
  }

  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    console.warn('[integration media] Rejected non-multipart upload');
    return errorResponse(
      'Content-Type must be multipart/form-data with a file field.',
      415,
      origin
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.warn('[integration media] Could not parse multipart form data', {
      error,
    });
    return errorResponse(
      'Invalid multipart request. Attach the image in the file field.',
      400,
      origin
    );
  }

  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    console.warn('[integration media] Multipart request is missing the file field');
    return errorResponse(
      'Missing multipart file field named "file".',
      400,
      origin
    );
  }

  if (file.size === 0) {
    console.warn('[integration media] Rejected empty file');
    return errorResponse('The uploaded file is empty.', 400, origin);
  }

  if (file.size > MAX_FILE_SIZE) {
    console.warn('[integration media] Rejected oversized file', {
      size: file.size,
      maxSize: MAX_FILE_SIZE,
    });
    return errorResponse(
      'File is too large. Maximum size is 4 MB.',
      413,
      origin
    );
  }

  if (!(file.type in ALLOWED_TYPES)) {
    console.warn('[integration media] Rejected unsupported media type', {
      contentType: file.type,
    });
    return errorResponse(
      'Unsupported file type. Allowed types: PNG, JPEG, and WebP.',
      415,
      origin
    );
  }

  const contentType = file.type as AllowedContentType;
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    await validateImage(buffer, contentType);
  } catch (error) {
    console.warn('[integration media] Image decode validation failed', {
      contentType,
      error,
    });
    return errorResponse(
      'Invalid, corrupt, or animated image. Provide a static PNG, JPEG, or WebP up to 16 megapixels.',
      415,
      origin
    );
  }

  const publicBase = process.env.R2_PUBLIC_URL;
  if (!publicBase) {
    console.error('[integration media] R2_PUBLIC_URL is not configured');
    return errorResponse(
      'Media storage is not configured. Set R2_PUBLIC_URL.',
      500,
      origin
    );
  }

  try {
    const url = await upload(
      buffer,
      contentType,
      ALLOWED_TYPES[contentType].extension
    );
    const canonicalUrl = canonicalizePublicR2Url(url, publicBase);
    if (!canonicalUrl) {
      console.error('[integration media] R2 returned a URL outside R2_PUBLIC_URL', {
        url,
      });
      return errorResponse(
        'Media storage returned an invalid public URL.',
        502,
        origin
      );
    }

    return NextResponse.json(
      { url: canonicalUrl },
      {
        status: 201,
        headers: corsHeaders(origin),
      }
    );
  } catch (error) {
    console.error('[integration media] R2 upload failed', { error });
    return errorResponse(
      'Media upload failed. Retry the request; contact the XHS platform operator if it persists.',
      502,
      origin
    );
  }
}
