import { afterEach, describe, expect, it } from 'vitest';
import { requirePlanIntegration } from '@/lib/plan-integration-auth';

describe('PLAN integration authentication', () => {
  afterEach(() => delete process.env.PLAN_INTEGRATION_TOKEN);

  it('accepts only the exact dedicated server bearer token', () => {
    const token = 'plan-token-that-is-at-least-32-characters';
    process.env.PLAN_INTEGRATION_TOKEN = token;
    expect(() => requirePlanIntegration(`Bearer ${token}`)).not.toThrow();
    expect(() => requirePlanIntegration('Bearer wrong')).toThrow(
      'Missing or invalid PLAN integration authorization',
    );
    expect(() => requirePlanIntegration(null)).toThrow(
      'Missing or invalid PLAN integration authorization',
    );
  });

  it('fails closed when the dedicated token is missing or too short', () => {
    expect(() => requirePlanIntegration('Bearer anything')).toThrow(
      'authentication is not configured',
    );
    process.env.PLAN_INTEGRATION_TOKEN = 'too-short';
    expect(() => requirePlanIntegration('Bearer too-short')).toThrow(
      'authentication is not configured',
    );
  });
});
