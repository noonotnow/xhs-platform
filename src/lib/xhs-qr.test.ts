import { describe, expect, it } from 'vitest';
import {
  canonicalCreatorQrUrl,
  UNSUPPORTED_CREATOR_QR_MESSAGE,
} from '@/lib/xhs-qr';

describe('canonicalCreatorQrUrl', () => {
  it('accepts a recursively encoded normal-account Rednote QR target', () => {
    const encoded = encodeURIComponent(
      encodeURIComponent('xhsdiscover://login/qr?code=creator'),
    );

    expect(canonicalCreatorQrUrl(encoded))
      .toBe('xhsdiscover://login/qr?code=creator');
  });

  it.each([
    'xhsdiscover://login/qr?redirect=xymerchant',
    'xhsdiscover://login/qr?redirect=QIANFAN',
    encodeURIComponent(
      encodeURIComponent('xhsdiscover://login/qr?redirect=xymerchant'),
    ),
    encodeURIComponent(
      encodeURIComponent('xhsdiscover://login/qr?redirect=QianFan'),
    ),
    Array.from({ length: 8 }).reduce(
      (url) => encodeURIComponent(url),
      'xhsdiscover://login/qr?redirect=xymerchant',
    ),
    Array.from({ length: 8 }).reduce(
      (url) => encodeURIComponent(url),
      'xhsdiscover://login/qr?redirect=qianfan',
    ),
  ])('rejects merchant and Qianfan QR targets without echoing them', (url) => {
    expect(() => canonicalCreatorQrUrl(url))
      .toThrow(UNSUPPORTED_CREATOR_QR_MESSAGE);
  });

  it('fails closed when recursive decoding exceeds the safety bound', () => {
    const overEncoded = Array.from({ length: 21 }).reduce(
      (url) => encodeURIComponent(url),
      'xhsdiscover://login/qr?code=creator',
    );

    expect(() => canonicalCreatorQrUrl(overEncoded))
      .toThrow(UNSUPPORTED_CREATOR_QR_MESSAGE);
  });

  it.each([
    'https://creator.rednote.com/login',
    'javascript:alert(1)',
    'not a URL',
    '',
  ])('rejects non-xhsdiscover targets', (url) => {
    expect(() => canonicalCreatorQrUrl(url))
      .toThrow(UNSUPPORTED_CREATOR_QR_MESSAGE);
  });
});
