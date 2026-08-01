export interface CreatorSessionResponse {
  valid?: boolean;
  session_type?: string;
  relogin_required?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
  detail?: string;
}

const CREATOR_LOGIN_URL = 'https://creator.rednote.com/login';

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
