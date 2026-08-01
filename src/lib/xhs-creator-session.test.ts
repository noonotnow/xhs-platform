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
        'XHS session expired: creator_session_invalid: The creator session is invalid ' +
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
});
