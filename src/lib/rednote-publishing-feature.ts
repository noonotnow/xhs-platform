import { REDNOTE_PUBLISHING_CONTRACT_REVISION } from '@/lib/rednote-publishing-contract-v1';
import { RednotePublishingError } from '@/lib/rednote-publishing-input';

export const REDNOTE_PUBLISHING_CONTROL_PLANE_ENV =
  'REDNOTE_PUBLISHING_CONTROL_PLANE_REVISION';

export function rednotePublishingControlPlaneEnabled() {
  return process.env[REDNOTE_PUBLISHING_CONTROL_PLANE_ENV] ===
    REDNOTE_PUBLISHING_CONTRACT_REVISION;
}

export function requireRednotePublishingStartEnabled() {
  if (!rednotePublishingControlPlaneEnabled()) {
    throw new RednotePublishingError(
      'The Rednote publishing control plane is disabled',
      'REDNOTE_CONTROL_PLANE_DISABLED',
      503,
    );
  }
}
