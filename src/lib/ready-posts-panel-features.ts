import {
  isCanonicalMediaImage,
  isCanonicalMediaMov,
  isCanonicalMediaVideo,
} from '@/lib/canonical-media';
import {
  BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
} from '@/lib/rednote-publish-job-recovery-contract';
import type {
  LocalPublishMediaType,
  RednotePublishJobRecoveryEvidence,
} from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

export const READY_POSTS_PANEL_FEATURES = {
  boundedBatchApproval: true,
  legacyExecutionAudits: false,
} as const;

export function resolveReadyPostSelection(
  posts: ReadonlyArray<{ id: string }>,
  currentId: string,
  requestedNotionPageId?: string,
) {
  if (requestedNotionPageId && posts.some((post) => post.id === requestedNotionPageId)) {
    return requestedNotionPageId;
  }
  if (posts.some((post) => post.id === currentId)) return currentId;
  return posts[0]?.id ?? '';
}

export type ReadyPostMediaChoice = {
  type: LocalPublishMediaType;
  index: number;
  url: string;
  compatibilityTrial?: 'unverified_mov';
};

export function readyPostMediaPreview(
  post: Pick<
    ReadyXhsPost,
    'candidateKind' | 'compatibilityTrialVideoUrls' | 'imageUrls' | 'thumbnailUrl' | 'videoUrls'
  >,
) {
  const candidates: ReadyPostMediaChoice[] =
    post.candidateKind === 'mov_compatibility_trial'
      ? (post.compatibilityTrialVideoUrls ?? []).map((url, index) => ({
          type: 'video',
          index,
          url,
          compatibilityTrial: 'unverified_mov',
        }))
      : [
          ...post.videoUrls.map((url, index) => ({ type: 'video' as const, index, url })),
          ...(post.compatibilityTrialVideoUrls ?? []).map((url, index) => ({
            type: 'video' as const,
            index,
            url,
            compatibilityTrial: 'unverified_mov' as const,
          })),
          ...post.imageUrls.map((url, index) => ({ type: 'image' as const, index, url })),
        ];
  const isTrustedChoice = (choice: ReadyPostMediaChoice) =>
    choice.compatibilityTrial
      ? isCanonicalMediaMov(choice.url)
      : choice.type === 'video'
        ? isCanonicalMediaVideo(choice.url)
        : isCanonicalMediaImage(choice.url);
  const trustedChoices = candidates.filter(isTrustedChoice);
  const rejectedUrls = candidates.filter((choice) => !isTrustedChoice(choice))
    .map((choice) => choice.url);
  const thumbnailUrl = isCanonicalMediaImage(post.thumbnailUrl)
    ? post.thumbnailUrl
    : undefined;
  if (post.thumbnailUrl && !thumbnailUrl) rejectedUrls.push(post.thumbnailUrl);
  return {
    choices: trustedChoices,
    rejectedUrls: rejectedUrls.filter((url, index) => rejectedUrls.indexOf(url) === index),
    thumbnailUrl,
  };
}

export function readyPostRecoveryAction(
  evidence: RednotePublishJobRecoveryEvidence,
  repairMissingAttemptLineage = false,
) {
  const browserClosed =
    evidence.recoveryKind === 'browser_closed_pre_publish';
  const reason = browserClosed
    ? 'Browser closed during approved pre-Publish media loading'
    : evidence.priorErrorCode === 'AMBIGUOUS_CREATOR_UI'
      ? 'Fixed image-mode pre-staging hydration failure'
      : evidence.priorErrorCode === 'NOT_LOGGED_IN'
        ? 'Persistent Creator browser profile required login before staging'
        : evidence.priorErrorCode === 'SCHEDULE_READBACK_MISMATCH'
          ? 'Creator did not retain the approved scheduled time before staging'
          : 'Bounded-batch bypass disabled';
  return {
    confirmation: browserClosed
      ? BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION
      : true,
    reason,
    failureDetail: browserClosed
      ? 'Recorded failure: the browser closed while loading approved media before Publish.\n'
      : evidence.priorErrorCode === 'AMBIGUOUS_CREATOR_UI'
        ? 'Fixed failure: image-mode pre-staging hydration could not uniquely identify the upload mode.\n'
        : evidence.priorErrorCode === 'NOT_LOGGED_IN'
          ? 'Recorded failure: the persistent Creator browser profile required login before staging.\n'
          : evidence.priorErrorCode === 'SCHEDULE_READBACK_MISMATCH'
            ? 'Recorded failure: Creator did not retain the approved scheduled time before staging.\n'
            : '',
    idleLabel: repairMissingAttemptLineage
      ? 'Repair missing attempt lineage'
      : browserClosed
        ? 'Confirm browser-closed recovery'
        : 'Confirm exact-job recovery',
    busyLabel: repairMissingAttemptLineage
      ? 'Repairing attempt lineage…'
      : browserClosed
        ? 'Recovering browser-closed job…'
        : 'Requeueing exact job…',
  } as const;
}
