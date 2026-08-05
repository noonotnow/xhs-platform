import { createHash, timingSafeEqual } from 'crypto';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const MIN_TOKEN_LENGTH = 32;

function workerToken() {
  const token = process.env.LOCAL_PUBLISH_WORKER_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new LocalPublishJobError(
      'Local publish worker authentication is not configured',
      'WORKER_AUTH_NOT_CONFIGURED',
      503,
    );
  }
  return token;
}

export function isLocalPublishWorkerAuthorized(authorization: string | null) {
  const expected = workerToken();
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return provided.length > 0 && timingSafeEqual(providedDigest, expectedDigest);
}

export function requireLocalPublishWorker(authorization: string | null) {
  if (!isLocalPublishWorkerAuthorized(authorization)) {
    throw new LocalPublishJobError(
      'Missing or invalid worker authorization',
      'UNAUTHORIZED',
      401,
    );
  }
}

export function parseClaimToken(value: string | null) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new LocalPublishJobError(
      'A valid X-Local-Publish-Claim-Token header is required',
      'INVALID_CLAIM_TOKEN',
      400,
    );
  }
  return value.toLowerCase();
}
