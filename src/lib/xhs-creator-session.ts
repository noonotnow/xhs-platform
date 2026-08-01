export interface CreatorSessionResponse {
  valid?: boolean;
  session_type?: string;
  relogin_required?: boolean;
  validation?: {
    method?: string;
    host?: string;
    path?: string;
  };
  error?: {
    code?: string;
    message?: string;
    reason?: CreatorSessionInvalidReason;
    upstream_status?: number;
    upstream_code?: number;
  };
  detail?: string;
}

export type CreatorSessionInvalidReason =
  | 'redirect'
  | 'http_401'
  | 'http_403'
  | 'api_session_expired';

const CREATOR_LOGIN_URL = 'https://creator.rednote.com/login';
const MAX_ERROR_DEPTH = 5;
const ERROR_ENVELOPE_KEYS = ['error', 'detail', 'message'] as const;
const INVALID_REASONS = new Set<CreatorSessionInvalidReason>([
  'redirect',
  'http_401',
  'http_403',
  'api_session_expired',
]);
const UNKNOWN_ERROR = {
  code: 'creator_session_status_unknown',
  message: 'Creator session status could not be read safely.',
} as const;
const CREATOR_SESSION_ERROR_CODES = new Set([
  'creator_session_invalid',
  'creator_session_validation_unavailable',
]);
const CREATOR_COOKIE_LOGIN_SESSION_ERROR_MESSAGES = {
  creator_session_invalid:
    'Creator session is not authenticated; re-login is required.',
  creator_session_validation_unavailable:
    'Creator validation is temporarily unavailable.',
} as const;

export const CREATOR_COOKIE_ERROR_MESSAGES = {
  cookie_header_control_character:
    'Cookie request header contains an unsupported control character.',
  cookie_header_invalid_name:
    'Cookie request header contains an invalid field name.',
  cookie_header_invalid_value:
    'Cookie request header contains an unsupported field value.',
  cookie_header_duplicate_name:
    'Cookie request header contains an ambiguous duplicate field.',
  cookie_header_missing_equals:
    'Cookie request header contains a malformed pair.',
  cookie_header_too_large:
    'Cookie request header exceeds the accepted size.',
  cookie_header_empty:
    'Cookie request header is empty.',
  cookie_header_invalid_type:
    'Cookie request body must contain one string field.',
  cookie_required_session_fields:
    'Cookie request header is missing required non-empty session fields.',
} as const;

type CreatorCookieErrorCode = keyof typeof CREATOR_COOKIE_ERROR_MESSAGES;

const CREATOR_COOKIE_ERROR_RECOVERY: Record<CreatorCookieErrorCode, string> = {
  cookie_header_control_character:
    'Use Copy value to copy only the single-line cookie request-header value; do not paste a header block or table export.',
  cookie_header_invalid_name:
    'Copy the cookie request-header value directly with Copy value; do not edit or combine it.',
  cookie_header_invalid_value:
    'Copy the cookie request-header value directly with Copy value; do not edit or combine it.',
  cookie_header_duplicate_name:
    'Copy one newly authenticated request with Copy value; do not combine cookies from multiple sources.',
  cookie_header_missing_equals:
    'Copy the cookie request-header value directly with Copy value; do not edit or combine it.',
  cookie_header_too_large:
    'Use Copy value to copy only the cookie request-header value, not all request headers or a cURL command.',
  cookie_header_empty:
    'Paste the cookie request-header value copied with Copy value.',
  cookie_header_invalid_type:
    'Use Copy value, then paste the cookie request-header value as plain text.',
  cookie_required_session_fields:
    `Sign in again at ${CREATOR_LOGIN_URL}, select a newly authenticated request, and copy its cookie request-header value with Copy value.`,
};

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function findAllowed<T>(
  value: unknown,
  read: (record: Record<string, unknown>) => T | undefined,
  depth = 0,
): T | undefined {
  if (depth > MAX_ERROR_DEPTH) return undefined;
  const record = parsedObject(value);
  if (!record) return undefined;

  const direct = read(record);
  if (direct !== undefined) return direct;

  for (const key of ERROR_ENVELOPE_KEYS) {
    const nested = findAllowed(record[key], read, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findString(value: unknown, key: string) {
  return findAllowed(value, (record) => {
    const candidate = nonEmptyString(record[key]);
    return candidate && !parsedObject(candidate) ? candidate : undefined;
  });
}

function findBoolean(value: unknown, key: string) {
  return findAllowed(value, (record) =>
    typeof record[key] === 'boolean' ? record[key] as boolean : undefined
  );
}

function safeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function findStructuredError(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > MAX_ERROR_DEPTH) return undefined;
  const record = parsedObject(value);
  if (!record) return undefined;

  const error = parsedObject(record.error);
  if (error) {
    if (
      'code' in error ||
      'message' in error ||
      'reason' in error ||
      'upstream_status' in error ||
      'upstream_code' in error
    ) {
      return error;
    }
    const nestedError = findStructuredError(error, depth + 1);
    if (nestedError) return nestedError;
  }

  for (const key of ['detail', 'message'] as const) {
    const nested = findStructuredError(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function allowedInvalidReason(value: unknown) {
  const reason = nonEmptyString(value);
  return reason && INVALID_REASONS.has(reason as CreatorSessionInvalidReason)
    ? reason as CreatorSessionInvalidReason
    : undefined;
}

function findEnvelopeMessage(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_ERROR_DEPTH) return undefined;
  const record = parsedObject(value);
  if (!record) return undefined;

  for (const key of ['message', 'detail', 'error'] as const) {
    const candidate = nonEmptyString(record[key]);
    if (candidate && !parsedObject(candidate)) return candidate;
    const nested = findEnvelopeMessage(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export function sanitizeCreatorSessionResponse(value: unknown): CreatorSessionResponse {
  const valid = findBoolean(value, 'valid');
  const sessionType = findString(value, 'session_type');
  const reloginRequired = findBoolean(value, 'relogin_required');
  const validation = findAllowed(value, (record) => parsedObject(record.validation));
  const candidateCode = findString(value, 'code');
  const cookieMessage = candidateCode
    ? CREATOR_COOKIE_ERROR_MESSAGES[candidateCode as CreatorCookieErrorCode]
    : undefined;
  const allowCreatorSessionError =
    candidateCode !== undefined && CREATOR_SESSION_ERROR_CODES.has(candidateCode);
  if (cookieMessage && candidateCode) {
    return {
      error: {
        code: candidateCode,
        message: cookieMessage,
      },
    };
  }
  if (candidateCode && !allowCreatorSessionError) {
    return { error: { ...UNKNOWN_ERROR } };
  }
  const code = allowCreatorSessionError ? candidateCode : undefined;
  const message = allowCreatorSessionError
    ? findString(value, 'message') || findEnvelopeMessage(value)
    : undefined;
  const structuredError = findStructuredError(value);
  const reason = allowedInvalidReason(structuredError?.reason);
  const upstreamStatus = safeInteger(structuredError?.upstream_status);
  const upstreamCode = safeInteger(structuredError?.upstream_code);
  const includeError = valid !== true;

  return {
    ...(valid !== undefined ? { valid } : {}),
    ...(sessionType ? { session_type: sessionType } : {}),
    ...(reloginRequired !== undefined ? { relogin_required: reloginRequired } : {}),
    ...(validation ? {
      validation: {
        ...(findString(validation, 'method') ? { method: findString(validation, 'method') } : {}),
        ...(findString(validation, 'host') ? { host: findString(validation, 'host') } : {}),
        ...(findString(validation, 'path') ? { path: findString(validation, 'path') } : {}),
      },
    } : {}),
    ...(includeError ? {
      error: {
        code: code || UNKNOWN_ERROR.code,
        message: message || UNKNOWN_ERROR.message,
        ...(reason ? { reason } : {}),
        ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
        ...(upstreamCode !== undefined ? { upstream_code: upstreamCode } : {}),
      },
    } : {}),
  };
}

export function sanitizeCreatorCookieLoginErrorResponse(
  value: unknown,
): CreatorSessionResponse {
  const code = findString(value, 'code');
  const cookieMessage = code
    ? CREATOR_COOKIE_ERROR_MESSAGES[code as CreatorCookieErrorCode]
    : undefined;
  const sessionMessage = code
    ? CREATOR_COOKIE_LOGIN_SESSION_ERROR_MESSAGES[
      code as keyof typeof CREATOR_COOKIE_LOGIN_SESSION_ERROR_MESSAGES
    ]
    : undefined;
  const message = cookieMessage || sessionMessage;

  return message && code
    ? { error: { code, message } }
    : { error: { ...UNKNOWN_ERROR } };
}

export function sanitizeCreatorCookieLoginSuccessResponse(
  value: unknown,
): CreatorSessionResponse {
  const body = parsedObject(value);
  return body?.valid === true && body.session_type === 'rednote_creator'
    ? { valid: true, session_type: 'rednote_creator' }
    : { error: { ...UNKNOWN_ERROR } };
}

function creatorSessionDiagnostic(body: CreatorSessionResponse) {
  const reason = body.error?.reason;
  if (!reason) return '';

  const reasonMessage: Record<CreatorSessionInvalidReason, string> = {
    redirect: 'creator validation redirected to sign-in',
    http_401: 'creator validation returned HTTP 401',
    http_403: 'creator validation returned HTTP 403',
    api_session_expired: 'Rednote reported the creator session expired',
  };
  const upstream = [
    body.error?.upstream_status !== undefined
      ? `upstream status ${body.error.upstream_status}`
      : '',
    body.error?.upstream_code !== undefined
      ? `upstream code ${body.error.upstream_code}`
      : '',
  ].filter(Boolean);

  return (
    ` Diagnostic: ${reason} - ${reasonMessage[reason]}` +
    `${upstream.length > 0 ? ` (${upstream.join(', ')})` : ''}.`
  );
}

export function creatorCookieFailureMessage(value: unknown) {
  const body = sanitizeCreatorSessionResponse(value);
  const code = body.error?.code?.trim();
  const message =
    body.error?.message?.trim() ||
    body.detail?.trim() ||
    UNKNOWN_ERROR.message;
  const safeError = code ? `${code}: ${message}` : message;
  const diagnostic = creatorSessionDiagnostic(body);
  const cookieRecovery = code
    ? CREATOR_COOKIE_ERROR_RECOVERY[code as CreatorCookieErrorCode]
    : undefined;

  if (cookieRecovery) return `${safeError} ${cookieRecovery}`;
  if (body.relogin_required || code === 'creator_session_invalid') {
    return (
      `${safeError}${diagnostic} Sign in again at ${CREATOR_LOGIN_URL}, then copy only the ` +
      'Request Headers Cookie from a fresh authenticated creator/webapi request.'
    );
  }
  if (code === 'creator_session_validation_unavailable') {
    return `${safeError} Your existing session was not replaced. Try again later.`;
  }
  return safeError;
}

export function creatorSessionStatusPresentation(value: unknown) {
  const body = sanitizeCreatorSessionResponse(value);
  if (body.valid === true) {
    return { valid: true as const, message: 'XHS session is valid.' };
  }

  const failure = creatorCookieFailureMessage(body);
  if (body.error?.code === 'creator_session_validation_unavailable') {
    return {
      valid: null,
      message: `XHS session validation unavailable: ${failure}`,
    };
  }
  if (
    body.valid === false ||
    body.relogin_required ||
    body.error?.code === 'creator_session_invalid'
  ) {
    return {
      valid: false as const,
      message: `Rednote creator session requires sign-in: ${failure}`,
    };
  }
  return {
    valid: null,
    message: `Rednote creator session check unavailable: ${failure}`,
  };
}
