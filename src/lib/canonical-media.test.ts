import { afterEach, expect, it, vi } from 'vitest';
import { isCanonicalMediaImage, isCanonicalMediaVideo } from './canonical-media';

afterEach(() => vi.unstubAllEnvs());
it('keeps the legacy authority by default', () => {
  vi.stubEnv('NEXT_PUBLIC_CANONICAL_MEDIA_ORIGIN', undefined);
  expect(isCanonicalMediaImage('https://images.xhs.justlikekatie.com/images/photo.png')).toBe(true);
  expect(isCanonicalMediaImage('https://other.r2.dev/images/photo.png')).toBe(false);
});
it('trusts one configured exact origin, not a provider suffix', () => {
  vi.stubEnv('NEXT_PUBLIC_CANONICAL_MEDIA_ORIGIN', 'https://synthetic.r2.dev');
  expect(isCanonicalMediaImage('https://synthetic.r2.dev/images/photo.png')).toBe(true);
  expect(isCanonicalMediaVideo('https://synthetic.r2.dev/videos/assets/asset/file.mp4')).toBe(true);
  expect(isCanonicalMediaImage('https://other.r2.dev/images/photo.png')).toBe(false);
  expect(isCanonicalMediaImage('https://synthetic.r2.dev.attacker.invalid/images/photo.png')).toBe(false);
  expect(isCanonicalMediaImage('https://user@synthetic.r2.dev/images/photo.png')).toBe(false);
  expect(isCanonicalMediaImage('https://synthetic.r2.dev:8443/images/photo.png')).toBe(false);
});
it.each(['', 'not-a-url', 'http://synthetic.r2.dev', 'https://synthetic.r2.dev/path',
  'https://user@synthetic.r2.dev', 'https://synthetic.r2.dev?token=value', 'https://synthetic.r2.dev#fragment',
  'https://synthetic.r2.dev:8443'])('fails closed on invalid authority %s', authority => {
  vi.stubEnv('NEXT_PUBLIC_CANONICAL_MEDIA_ORIGIN', authority);
  expect(isCanonicalMediaImage('https://images.xhs.justlikekatie.com/images/photo.png')).toBe(false);
});