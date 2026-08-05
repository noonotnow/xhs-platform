import type { XhsPost } from '@/types/ready-post';

export const MOV_COMPATIBILITY_BLOCKER = 'No canonical HTTPS Rednote media is attached';
export const MOV_MEDIA_STATE_BLOCKER = 'Needs media is still checked';

const MOV_TRIAL_ALLOWED_BLOCKERS = new Set([
  MOV_COMPATIBILITY_BLOCKER,
  MOV_MEDIA_STATE_BLOCKER,
]);

type MovTrialPost = Pick<
  XhsPost,
  | 'compatibilityTrialVideoUrls'
  | 'hasVideo'
  | 'needsMedia'
  | 'publishPacketReady'
  | 'publishBlockers'
>;

export function movCompatibilityTrialBlockers(post: MovTrialPost) {
  return post.publishBlockers.filter((blocker) => !MOV_TRIAL_ALLOWED_BLOCKERS.has(blocker));
}

export function isMovCompatibilityTrialEligible(post: MovTrialPost) {
  const blockers = new Set(post.publishBlockers);
  return !post.publishPacketReady &&
    post.hasVideo &&
    post.needsMedia &&
    (post.compatibilityTrialVideoUrls?.length ?? 0) > 0 &&
    blockers.size === MOV_TRIAL_ALLOWED_BLOCKERS.size &&
    Array.from(MOV_TRIAL_ALLOWED_BLOCKERS).every((blocker) => blockers.has(blocker));
}
