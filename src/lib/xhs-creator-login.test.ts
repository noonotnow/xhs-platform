import { describe, expect, it } from 'vitest';
import {
  CREATOR_COOKIE_COPY_VALUE_INSTRUCTION,
  CREATOR_COOKIE_COPY_WARNING,
} from '@/lib/xhs-creator-login';

describe('Creator cookie copy instructions', () => {
  it('directs operators to copy only the request-header value', () => {
    expect(CREATOR_COOKIE_COPY_VALUE_INSTRUCTION).toBe(
      'In browser DevTools, open Network and select a newly authenticated ' +
      'creator.rednote.com request. Under Request Headers, right-click the cookie ' +
      'request-header value and choose Copy value.',
    );
  });

  it('warns against copy paths that include non-cookie request data', () => {
    expect(CREATOR_COOKIE_COPY_WARNING).toBe(
      'Do not use Copy all, Copy request headers, Copy as cURL, or the Application ' +
      'cookie table or export.',
    );
    expect(CREATOR_COOKIE_COPY_WARNING).not.toContain('=');
  });
});
