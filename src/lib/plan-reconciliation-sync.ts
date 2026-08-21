const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const NOTION_PAGE_ID = /^[0-9a-f-]{32,36}$/i;

export type PlanProvenanceSyncOutcome =
  | { status: 'synced'; enrichment: unknown }
  | { status: 'not-configured'; code: string; message: string }
  | { status: 'failed'; code: string; message: string; httpStatus?: number };

export interface PlanProvenanceSyncOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Notify PLAN after XHS has durably reconciled an operator receipt. */
export async function syncReconciledPlanProvenance(
  notionPageId: string,
  options: PlanProvenanceSyncOptions = {},
): Promise<PlanProvenanceSyncOutcome> {
  if (!NOTION_PAGE_ID.test(notionPageId)) {
    return {
      status: 'failed',
      code: 'PLAN_RECONCILIATION_SYNC_INVALID_PAGE_ID',
      message: 'The reconciled execution has an invalid Notion page ID.',
    };
  }

  const env = options.env ?? process.env;
  const token = env.PLAN_INTEGRATION_TOKEN?.trim() ?? '';
  const configuredUrl = env.PLAN_RECONCILIATION_CALLBACK_URL?.trim() ?? '';
  if (token.length < 32) {
    return {
      status: 'not-configured',
      code: 'PLAN_RECONCILIATION_SYNC_TOKEN_MISSING',
      message: 'PLAN_INTEGRATION_TOKEN is not configured for the reconciliation callback.',
    };
  }
  if (!configuredUrl) {
    return {
      status: 'not-configured',
      code: 'PLAN_RECONCILIATION_SYNC_URL_MISSING',
      message: 'PLAN_RECONCILIATION_CALLBACK_URL is not configured.',
    };
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(configuredUrl);
  } catch {
    return invalidCallbackUrl();
  }
  if (
    callbackUrl.protocol !== 'https:'
    || callbackUrl.pathname.replace(/\/+$/, '') !== '/api/posts/operator-scheduled'
  ) {
    return invalidCallbackUrl();
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(callbackUrl.toString(), {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notionPageId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: 'failed',
        code: responseCode(payload) ?? 'PLAN_RECONCILIATION_SYNC_REJECTED',
        message: 'PLAN rejected the reconciliation provenance sync.',
        httpStatus: response.status,
      };
    }
    return {
      status: 'synced',
      enrichment: payload && typeof payload === 'object' && 'enrichment' in payload
        ? payload.enrichment
        : null,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      status: 'failed',
      code: timedOut
        ? 'PLAN_RECONCILIATION_SYNC_TIMEOUT'
        : 'PLAN_RECONCILIATION_SYNC_UNAVAILABLE',
      message: timedOut
        ? 'PLAN did not respond before the reconciliation sync timeout.'
        : 'XHS could not reach PLAN for reconciliation provenance sync.',
    };
  }
}

function invalidCallbackUrl(): PlanProvenanceSyncOutcome {
  return {
    status: 'not-configured',
    code: 'PLAN_RECONCILIATION_SYNC_URL_INVALID',
    message: 'PLAN_RECONCILIATION_CALLBACK_URL must be an HTTPS operator-scheduled endpoint.',
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text || text.length > MAX_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const code = Reflect.get(payload, 'code');
  return typeof code === 'string' && code ? code : null;
}
