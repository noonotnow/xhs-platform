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

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sanitizeCreatorSessionResponse(value: unknown): CreatorSessionResponse {
  if (!value || typeof value !== 'object') return {};

  const outer = value as Record<string, unknown>;
  const record = outer.detail && typeof outer.detail === 'object'
    ? outer.detail as Record<string, unknown>
    : outer;
  const validation = record.validation && typeof record.validation === 'object'
    ? record.validation as Record<string, unknown>
    : undefined;
  const error = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : undefined;

  return {
    ...(typeof record.valid === 'boolean' ? { valid: record.valid } : {}),
    ...(nonEmptyString(record.session_type)
      ? { session_type: nonEmptyString(record.session_type) }
      : {}),
    ...(typeof record.relogin_required === 'boolean'
      ? { relogin_required: record.relogin_required }
      : {}),
    ...(validation ? {
      validation: {
        ...(nonEmptyString(validation.method)
          ? { method: nonEmptyString(validation.method) }
          : {}),
        ...(nonEmptyString(validation.host)
          ? { host: nonEmptyString(validation.host) }
          : {}),
        ...(nonEmptyString(validation.path)
          ? { path: nonEmptyString(validation.path) }
          : {}),
      },
    } : {}),
    ...(error ? {
      error: {
        ...(nonEmptyString(error.code) ? { code: nonEmptyString(error.code) } : {}),
        ...(nonEmptyString(error.message)
          ? { message: nonEmptyString(error.message) }
          : {}),
      },
    } : {}),
    ...(nonEmptyString(record.detail) ? { detail: nonEmptyString(record.detail) } : {}),
  };
}

export function creatorCookieFailureMessage(body: CreatorSessionResponse) {
  const code = body.error?.code?.trim();
  const message = body.error?.message?.trim() || body.detail?.trim() || 'Request failed';
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

export function creatorSessionStatusPresentation(body: CreatorSessionResponse) {
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
  return {
    valid: false as const,
    message: `XHS session expired: ${failure}`,
  };
}
