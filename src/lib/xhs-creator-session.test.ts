import { describe, expect, it } from 'vitest';
import { creatorCookieFailureMessage } from '@/lib/xhs-creator-session';

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
});
