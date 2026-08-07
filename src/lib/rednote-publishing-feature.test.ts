import { afterEach, describe, expect, it } from 'vitest';
import {
  rednotePublishingControlPlaneEnabled,
  requireRednotePublishingStartEnabled,
} from '@/lib/rednote-publishing-feature';

describe('Rednote publishing feature gate', () => {
  afterEach(() => {
    delete process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION;
  });

  it('requires the exact frozen revision', () => {
    expect(rednotePublishingControlPlaneEnabled()).toBe(false);
    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1-extra';
    expect(rednotePublishingControlPlaneEnabled()).toBe(false);
    expect(requireRednotePublishingStartEnabled).toThrowError(
      expect.objectContaining({ code: 'REDNOTE_CONTROL_PLANE_DISABLED' }),
    );

    process.env.REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION =
      'rednote-publishing/v1';
    expect(rednotePublishingControlPlaneEnabled()).toBe(true);
    expect(requireRednotePublishingStartEnabled()).toBeUndefined();
  });
});
