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
  };
  detail?: string;
}

const CREATOR_LOGIN_URL = 'https://creator.rednote.com/login';
const MAX_ERROR_DEPTH = 5;
const ERROR_ENVELOPE_KEYS = ['error', 'detail', 'message'] as const;
const UNKNOWN_ERROR = {
  code: 'creator_session_status_unknown',
  message: 'Creator session status could not be read safely.',
} as const;

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
  const code = findString(value, 'code');
  const message = findString(value, 'message') || findEnvelopeMessage(value);
  const detail = findString(value, 'detail');
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
      },
    } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function creatorCookieFailureMessage(value: unknown) {
  const body = sanitizeCreatorSessionResponse(value);
  const code = body.error?.code?.trim();
  const message =
    body.error?.message?.trim() ||
    body.detail?.trim() ||
    UNKNOWN_ERROR.message;
  const safeError = code ? `${code}: ${message}` : message;

  if (body.relogin_required || code === 'creator_session_invalid') {
    return (
      `${safeError} Sign in again at ${CREATOR_LOGIN_URL}, then copy only the ` +
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
