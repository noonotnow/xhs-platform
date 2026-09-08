import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => 'jwks'),
  jwtVerify: vi.fn(),
}));

vi.mock('jose', () => jose);

import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';

describe('Cloudflare Access validation', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCESS_AUDIENCE', 'admin-audience');
    jose.createRemoteJWKSet.mockClear();
    jose.jwtVerify.mockReset();
    jose.jwtVerify.mockResolvedValue({
      payload: { email: 'operator@example.com' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives the issuer from the configured team domain', async () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', 'team.cloudflareaccess.com');

    await expect(validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    })).resolves.toEqual({ email: 'operator@example.com' });

    expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://team.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(jose.jwtVerify).toHaveBeenCalledWith('assertion', 'jwks', {
      issuer: [
        'https://team.cloudflareaccess.com',
        'https://team.cloudflareaccess.com/',
      ],
      audience: 'admin-audience',
    });
  });

  it('prefers an explicit issuer override', async () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', 'team.cloudflareaccess.com');
    vi.stubEnv('CLOUDFLARE_ACCESS_ISSUER', 'https://override.cloudflareaccess.com/');

    await validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    });

    expect(jose.jwtVerify).toHaveBeenCalledWith('assertion', 'jwks', {
      issuer: [
        'https://override.cloudflareaccess.com',
        'https://override.cloudflareaccess.com/',
      ],
      audience: 'admin-audience',
    });
  });

  it.each([
    ['missing issuer', undefined, undefined],
    ['malformed team domain', 'not a domain/path', undefined],
    ['insecure explicit issuer', undefined, 'http://team.cloudflareaccess.com'],
  ])('fails closed for %s', async (_case, teamDomain, issuer) => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', teamDomain);
    vi.stubEnv('CLOUDFLARE_ACCESS_ISSUER', issuer);

    await expect(validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    })).rejects.toThrow('Cloudflare Access is not configured');

    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it('fails closed when audience configuration is missing', async () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', 'team.cloudflareaccess.com');
    vi.stubEnv('CLOUDFLARE_ACCESS_AUDIENCE', undefined);

    await expect(validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    })).rejects.toThrow('Cloudflare Access is not configured');

    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it('propagates signature and audience verification failures', async () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', 'team.cloudflareaccess.com');
    jose.jwtVerify.mockRejectedValue(new Error('JWT verification failed'));

    await expect(validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    })).rejects.toThrow('JWT verification failed');
  });

  it('rejects a verified assertion without an email identity', async () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_TEAM_DOMAIN', 'team.cloudflareaccess.com');
    jose.jwtVerify.mockResolvedValue({ payload: {} });

    await expect(validateCloudflareAccessRequest({
      headers: new Headers({ 'cf-access-jwt-assertion': 'assertion' }),
    })).rejects.toThrow('Cloudflare Access identity email is missing');
  });
});
