import {
  isCanonicalMediaImage,
  isCanonicalMediaMov,
  isCanonicalMediaVideo,
} from '@/lib/canonical-media';
import type { LocalPublishMediaType } from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

export const READY_POSTS_PANEL_FEATURES = {
  boundedBatchApproval: true,
  legacyExecutionAudits: false,
} as const;

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
