import { createHmac, randomBytes } from 'crypto';

const UPLOAD_GRANT_TTL_SECONDS = 120;

export interface UploadGrantPayload {
  exp: number;
  method: 'POST';
  path: '/upload';
  nonce: string;
}

export interface UploadGrant {
  token: string;
  expiresAt: number;
}

export function createUploadGrant(now = Math.floor(Date.now() / 1000)): UploadGrant {
  const secret = process.env.UPLOAD_TOKEN_SECRET;
  if (!secret) throw new Error('UPLOAD_TOKEN_SECRET is not configured');

  const payload: UploadGrantPayload = {
    exp: now + UPLOAD_GRANT_TTL_SECONDS,
    method: 'POST',
    path: '/upload',
    nonce: randomBytes(16).toString('base64url'),
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signatureSegment = createHmac('sha256', secret)
    .update(payloadSegment, 'ascii')
    .digest('base64url');

  return {
    token: `${payloadSegment}.${signatureSegment}`,
    expiresAt: payload.exp,
  };
}
