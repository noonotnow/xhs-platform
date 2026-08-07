import { createHash, timingSafeEqual } from 'crypto';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { RednotePublishingError } from '@/lib/rednote-publishing-input';

const MIN_TOKEN_LENGTH = 32;

export type RednoteRequesterPrincipal = {
  requester: 'create' | 'plan' | 'admin';
  actorId: string;
};

export type RednoteWorkerPrincipal = {
  requester: 'worker';
  actorId: string;
};

export type RednoteAdminPrincipal = {
  requester: 'admin';
  actorId: string;
};

function requireBearer(
  authorization: string | null,
  environmentName: 'CREATE_INTEGRATION_TOKEN' | 'PLAN_INTEGRATION_TOKEN' |
    'LOCAL_PUBLISH_WORKER_TOKEN',
) {
  const expected = process.env[environmentName]?.trim();
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    throw new RednotePublishingError(
      `${environmentName} authentication is not configured`,
      'REDNOTE_AUTH_NOT_CONFIGURED',
      503,
    );
  }
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const expectedDigest = createHash('sha256').update(expected).digest();
  const providedDigest = createHash('sha256').update(provided).digest();
  if (!provided || !timingSafeEqual(expectedDigest, providedDigest)) {
    throw new RednotePublishingError(
      'Missing or invalid Rednote control-plane authorization',
      'UNAUTHORIZED',
      401,
    );
  }
}

export function requireRednoteCreate(
  authorization: string | null,
): RednoteRequesterPrincipal {
  requireBearer(authorization, 'CREATE_INTEGRATION_TOKEN');
  return { requester: 'create', actorId: 'create-integration' };
}

export function requireRednotePlan(
  authorization: string | null,
): RednoteRequesterPrincipal {
  requireBearer(authorization, 'PLAN_INTEGRATION_TOKEN');
  return { requester: 'plan', actorId: 'plan-integration' };
}

export function requireRednoteWorker(
  authorization: string | null,
): RednoteWorkerPrincipal {
  requireBearer(authorization, 'LOCAL_PUBLISH_WORKER_TOKEN');
  return { requester: 'worker', actorId: 'local-publish-worker' };
}

export async function requireRednoteAdmin(
  request: Pick<Request, 'headers'>,
): Promise<RednoteAdminPrincipal> {
  try {
    const operator = await validateCloudflareAccessRequest(request);
    return { requester: 'admin', actorId: operator.email };
  } catch {
    throw new RednotePublishingError(
      'Missing or invalid operator authorization',
      'UNAUTHORIZED',
      401,
    );
  }
}
