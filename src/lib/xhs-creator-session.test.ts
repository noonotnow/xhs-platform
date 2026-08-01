import { describe, expect, it } from 'vitest';
import {
  creatorCookieFailureMessage,
  creatorSessionStatusPresentation,
  sanitizeCreatorSessionResponse,
} from '@/lib/xhs-creator-session';

describe('creatorCookieFailureMessage', () => {
  it('preserves the safe invalid-session code and gives re-login guidance', () => {
    expect(creatorCookieFailureMessage({
      valid: false,
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    })).toBe(
      'creator_session_invalid: The creator session is invalid ' +
      'Sign in again at https://creator.rednote.com/login, then copy only the ' +
      'Request Headers Cookie from a fresh authenticated creator/webapi request.',
    );
  });

  it('explains that a temporary validation failure preserved the current session', () => {
    expect(creatorCookieFailureMessage({
      error: {
        code: 'creator_session_validation_unavailable',
        message: 'Creator validation is temporarily unavailable',
      },
    })).toBe(
      'creator_session_validation_unavailable: Creator validation is temporarily unavailable ' +
      'Your existing session was not replaced. Try again later.',
    );
  });

  it('allowlists and unwraps object-shaped detail errors', () => {
    expect(sanitizeCreatorSessionResponse({
      detail: {
        valid: false,
        session_type: 'rednote_creator',
        relogin_required: true,
        error: {
          code: 'creator_session_invalid',
          message: 'The creator session is invalid',
        },
        cookie: 'must-not-leak',
      },
      internal: 'must-not-leak',
    })).toEqual({
      valid: false,
      session_type: 'rednote_creator',
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    });
  });

  it('renders object-shaped invalid-session errors without string coercion', () => {
    expect(creatorSessionStatusPresentation({
      valid: false,
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    })).toEqual({
      valid: false,
      message:
        'Rednote creator session requires sign-in: creator_session_invalid: ' +
        'The creator session is invalid ' +
        'Sign in again at https://creator.rednote.com/login, then copy only the ' +
        'Request Headers Cookie from a fresh authenticated creator/webapi request.',
    });
  });

  it('distinguishes a validation outage from an expired session', () => {
    expect(creatorSessionStatusPresentation({
      error: {
        code: 'creator_session_validation_unavailable',
        message: 'Creator validation is temporarily unavailable',
      },
    })).toEqual({
      valid: null,
      message:
        'XHS session validation unavailable: creator_session_validation_unavailable: ' +
        'Creator validation is temporarily unavailable Your existing session was not replaced. ' +
        'Try again later.',
    });
  });

  it('normalizes the deployed microservice session payload exactly', () => {
    const payload = {
      valid: false,
      session_type: 'rednote_creator',
      validation: {
        method: 'creator_profile',
        host: 'creator.rednote.com',
        path: '/api/galaxy/creator/home/personal_info',
      },
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'Creator session is not authenticated; re-login is required.',
      },
    };

    expect(creatorSessionStatusPresentation(payload)).toEqual({
      valid: false,
      message:
        'Rednote creator session requires sign-in: creator_session_invalid: ' +
        'Creator session is not authenticated; re-login is required. Sign in again at ' +
        'https://creator.rednote.com/login, then copy only the Request Headers Cookie from ' +
        'a fresh authenticated creator/webapi request.',
    });
  });

  it('recursively normalizes JSON-encoded safe error envelopes', () => {
    const payload = {
      valid: false,
      detail: JSON.stringify({
        error: {
          detail: {
            code: 'creator_session_invalid',
            message: {
              message: 'Creator session needs a fresh login.',
              cookie: 'must-not-leak',
            },
          },
        },
      }),
      raw_cookie: 'must-not-leak',
    };

    const normalized = sanitizeCreatorSessionResponse(payload);
    expect(normalized.error).toEqual({
      code: 'creator_session_invalid',
      message: 'Creator session needs a fresh login.',
    });
    expect(JSON.stringify(normalized)).not.toContain('must-not-leak');
    expect(creatorSessionStatusPresentation(payload).message)
      .not.toContain('[object Object]');
  });

  it('uses a fixed safe fallback for unknown object-shaped errors', () => {
    const presentation = creatorSessionStatusPresentation({
      valid: false,
      error: {
        unexpected: { secret: 'must-not-leak' },
      },
    });

    expect(presentation).toEqual({
      valid: false,
      message:
        'Rednote creator session requires sign-in: creator_session_status_unknown: ' +
        'Creator session status could not be read safely.',
    });
    expect(presentation.message).not.toContain('[object Object]');
    expect(presentation.message).not.toContain('must-not-leak');
  });

  it('treats an empty malformed payload as an unavailable check', () => {
    expect(creatorSessionStatusPresentation({})).toEqual({
      valid: null,
      message:
        'Rednote creator session check unavailable: creator_session_status_unknown: ' +
        'Creator session status could not be read safely.',
    });
  });

  it.each([
    ['redirect', 'creator validation redirected to sign-in'],
    ['http_401', 'creator validation returned HTTP 401'],
    ['http_403', 'creator validation returned HTTP 403'],
    ['api_session_expired', 'Rednote reported the creator session expired'],
  ] as const)('renders the allowlisted %s invalid-session reason', (reason, description) => {
    const presentation = creatorSessionStatusPresentation({
      valid: false,
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'Creator session is not authenticated; re-login is required.',
        reason,
        upstream_status: reason === 'redirect' ? 302 : 200,
        upstream_code: reason === 'api_session_expired' ? -100 : 0,
      },
    });

    expect(presentation.message).toContain(`Diagnostic: ${reason} - ${description}`);
    expect(presentation.message).toContain(
      `upstream status ${reason === 'redirect' ? 302 : 200}`,
    );
    expect(presentation.message).toContain(
      `upstream code ${reason === 'api_session_expired' ? -100 : 0}`,
    );
    expect(presentation.message).toContain(
      'Sign in again at https://creator.rednote.com/login',
    );
  });

  it('drops unknown reasons, non-numeric diagnostics, and arbitrary fields', () => {
    const normalized = sanitizeCreatorSessionResponse({
      valid: false,
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'Creator session is invalid.',
        reason: 'cookie_rejected_for_secret_reason',
        upstream_status: '401',
        upstream_code: { raw: -100 },
        cookie: 'must-not-leak',
        location: 'must-not-leak',
        response_body: 'must-not-leak',
      },
      headers: { cookie: 'must-not-leak' },
    });

    expect(normalized).toEqual({
      valid: false,
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'Creator session is invalid.',
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('must-not-leak');
  });

  it('does not promote diagnostic-looking fields outside the error object', () => {
    const normalized = sanitizeCreatorSessionResponse({
      valid: false,
      reason: 'redirect',
      upstream_status: 302,
      upstream_code: -100,
      detail: {
        reason: 'http_401',
        upstream_status: 401,
      },
      error: {
        code: 'creator_session_invalid',
        message: 'Creator session is invalid.',
      },
    });

    expect(normalized.error).toEqual({
      code: 'creator_session_invalid',
      message: 'Creator session is invalid.',
    });
  });
});
