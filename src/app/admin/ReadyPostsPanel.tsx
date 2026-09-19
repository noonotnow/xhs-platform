'use client';

import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  ExternalReconciliationSummary,
  LocalPublishJobSummary,
  ManualSchedulingAttestationEvidence,
  ManualReconciliationSummary,
  OperatorSuccessAttestationEvidence,
  PublicRednotePublishJobRecovery,
  PublishBatch,
  PublishBatchItemState,
  RednotePublishJobRecoveryEvidence,
} from '@/types/local-publish-job';
import type { ReadyXhsPost, ReadyXhsPostsResponse } from '@/types/ready-post';
import type {
  ManualHandlingMode,
  ManualPostHandlingResponse,
} from '@/types/manual-post-handling';
import styles from './ReadyPostsPanel.module.css';
import { responseJson } from '@/lib/response-json';
import {
  getEditorialScheduleDisplay,
  type EditorialScheduleStatus,
} from '@/lib/editorial-schedule';
import { normalizeRednotePublicIdentity } from '@/lib/rednote-publication';
import {
  canSharePreparedPacket,
  copyHandoffText,
  formatTags,
  formatRednoteHandoffText,
  getMissingTags,
  isManualHandoffEligible,
  isPreparedHandoffFresh,
  PREPARED_HANDOFF_FRESHNESS_MS,
  prepareOrderedMediaFiles,
  REDNOTE_CREATOR_PUBLISH_URL,
  SAFE_EXTERNAL_LINK_PROPS,
  shouldOfferTitleCopy,
} from '@/lib/manual-rednote-handoff';
import { isMovCompatibilityTrialEligible } from '@/lib/mov-compatibility-trial';
import {
  directManualSchedulingCandidate,
  displayedLocalPublishJob,
  hasExpiredPublishClaim,
  hasLiveUnsafeAutomationOwnership,
  isActiveLocalPublishJob,
  publicationOperationalTruth,
  receiptPendingLocalPublishJobs,
} from '@/lib/local-publish-job-display';
import { manualSchedulingProvenanceMismatch } from '@/lib/manual-scheduling-provenance';
import {
  READY_POSTS_PANEL_FEATURES,
  readyPostMediaPreview,
  readyPostRecoveryAction,
  requestedReadyPostIsMissing,
  resolveReadyPostSelection,
  type ReadyPostMediaChoice,
} from '@/lib/ready-posts-panel-features';
import {
  adminApiFetch,
  isEligibleAdminRednoteAttempt,
  parseAdminLocalJobsResponse,
  type AdminRednoteAttemptSummary,
} from '@/lib/admin-api-client';

interface ApiError {
  error?: string;
  code?: string;
}

interface PublishBatchesResponse extends ApiError {
  batches: PublishBatch[];
  batch?: PublishBatch | null;
}

type LocalJobsResponse = ApiError & Record<string, unknown>;

interface PublishJobRecoveryResponse extends ApiError {
  recovery: PublicRednotePublishJobRecovery;
}

function manualPublicPostError(value: string) {
  const candidate = value.trim();
  if (!candidate) return '';
  return normalizeRednotePublicIdentity(candidate)
    ? ''
    : 'Use a public https://www.rednote.com/explore/NOTE_ID URL or bare note ID.';
}

interface LocalJobResponse extends ApiError {
  job: LocalPublishJobSummary;
}

interface ManualSchedulingAttestationResponse extends ApiError {
  attestation: OperatorSuccessAttestationEvidence;
}

interface ExternalReconciliationsResponse extends ApiError {
  reconciliations: ExternalReconciliationSummary[];
}

interface ManualReconciliationsResponse extends ApiError {
  reconciliations: ManualReconciliationSummary[];
}

interface ManualReconciliationResponse extends ApiError {
  reconciliation: ManualReconciliationSummary;
}

type CopyStatus = {
  ok: boolean;
  message: string;
};

type MobileHandoffStatus = {
  tone: 'success' | 'warning' | 'error';
  message: string;
};

type MobileHandoffIdentity = {
  workspaceId: string;
  postId: string;
  sourceRevision: string;
  localPublishJobId: string;
  durableAttemptId: string;
  payloadDigest: string;
  payloadRevision: string;
  batchId: string;
  manifestHash: string;
  itemHash: string;
  mediaIdentities: string[];
  title: string;
  caption: string;
  tags: string[];
  text: string;
  validatedAt: number;
  preparation: 'prepared';
  shareable: boolean;
  clipboard: 'not_attempted' | 'succeeded' | 'failed';
  share: 'not_attempted' | 'completed' | 'unsupported' | 'failed';
  creator: 'not_attempted' | 'opening_attempted';
};

type PreparedMobileHandoff = {
  identity: MobileHandoffIdentity;
  files: File[];
  downloadUrls: string[];
};

function mobileHandoffStorageKey(workspaceId: string, postId: string) {
  return `xhs-mobile-handoff:${workspaceId}:${postId}`;
}

function shanghaiTime(publishAt: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(publishAt)) + ' (Shanghai)';
  } catch {
    return '';
  }
}

function batchItemStateLabel(state: PublishBatchItemState): string {
  switch (state) {
    case 'approved': return 'Pending';
    case 'queued': return 'Queued';
    case 'claimed': return 'Claiming';
    case 'staged': return 'Staged';
    case 'scheduled': return '✓ Scheduled';
    case 'submitted': return 'Submitted';
    case 'operator_attested': return 'Operator attested';
    case 'verification_pending': return 'Verifying';
    case 'verified': return '✓ Verified';
    case 'reconciled': return '✓ Reconciled';
    case 'failed': return '⚠ Failed';
    case 'invalidated': return 'Invalidated';
    case 'needs_approval': return 'Needs approval';
    default: return state;
  }
}

function scheduleStatusClass(status: EditorialScheduleStatus) {
  return {
    overdue: styles.scheduleOverdue,
    due: styles.scheduleDue,
    upcoming: styles.scheduleUpcoming,
    unscheduled: styles.scheduleUnscheduled,
  }[status];
}

function tagsFromInput(value: string) {
  return value
    .split(/[,\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean);
}

function publishTiming(post: ReadyXhsPost) {
  const schedule = getEditorialScheduleDisplay(post.scheduledDate);
  if (post.automationBlockers.includes(
    'ScheduledDate must include a valid publish time and timezone',
  )) {
    return {
      label: 'Invalid ScheduledDate',
      detail: 'Set an exact publish time with timezone in Notion before queueing. The editorial display remains advisory.',
    };
  }
  if (!post.publishAt) {
    return {
      label: schedule.statusLabel,
      detail: schedule.china
        ? `${schedule.et} · ${schedule.china}`
        : `${schedule.et}. Set an exact instant with timezone before batch approval.`,
    };
  }
  return {
    label: schedule.statusLabel,
    detail: `${schedule.et} · ${schedule.china}`,
  };
}

function jobStatusCopy(
  job: LocalPublishJobSummary | undefined,
  post?: ReadyXhsPost,
) {
  if (!job) return null;
  const movTrial = job.compatibilityTrial === 'unverified_mov';
  if (job.status === 'queued') {
    return {
      tone: movTrial ? 'warning' : 'pending',
      title: movTrial
        ? 'Unverified MOV staging trial queued'
        : 'Queued for the Mac worker',
      detail: movTrial
        ? 'Waiting for Creator staging. MOV is not certified and this post is not published.'
        : 'Waiting for the local browser worker. This post is not published.',
    };
  }

  if (job.status === 'claimed') {
    const expired = hasExpiredPublishClaim(job);
    return {
      tone: expired || movTrial ? 'warning' : 'pending',
      title: expired
        ? 'Worker lease expired · reconciliation only'
        : movTrial
        ? 'Unverified MOV staging trial claimed'
        : 'Claimed by the Mac worker',
      detail: expired
        ? 'The frozen attempt will not be dispatched again. Worker failed is now Katie-owned report truth.'
        : movTrial
        ? 'Creator staging or human review is in progress. Publishing still requires the exact job approval.'
        : 'Browser staging or human review is in progress. This post is not published yet.',
    };
  }
  if (job.status === 'staged') {
    const expired = hasExpiredPublishClaim(job);
    return {
      tone: expired ? 'warning' : 'pending',
      title: expired ? 'Staging lease expired · reconciliation only' : 'Staged in RedNote Creator',
      detail: expired
        ? 'Automatic dispatch is permanently closed. Worker failed is now Katie-owned report truth.'
        : 'The packet is staged but has not been submitted. A definitive staging error may still fail safely.',
    };
  }
  if (job.status === 'submitted' || job.status === 'scheduled') {
    return {
      tone: 'pending',
      title: job.status === 'scheduled'
        ? 'Scheduled in RedNote Creator'
        : 'Submitted to RedNote',
      detail: job.nextVerificationAt
        ? `The publish receipt is saved. Ownership verification is due ${new Intl.DateTimeFormat(
            undefined,
            { dateStyle: 'medium', timeStyle: 'short' },
          ).format(new Date(job.nextVerificationAt))}. Do not publish again.`
        : 'The publish receipt is saved. Verify the existing post; do not publish again.',
    };
  }
  if (job.status === 'operator_attested') {
    if (job.successAttestation?.provenance === 'manual_scheduled') {
      const mismatch = post
        ? manualSchedulingProvenanceMismatch(post, job.successAttestation)
        : null;
      const attestedTime = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'America/New_York',
      }).format(new Date(job.successAttestation.requestedPublishAt));
      if (mismatch) {
        return {
          tone: 'warning',
          title: 'Scheduled · provenance mismatch · needs review',
          detail:
            `The immutable assertion records ${attestedTime} ET at source revision ` +
            `${job.successAttestation.snapshotRevision}, but the current Notion ScheduledDate ` +
            'or Post revision no longer matches. Dispatch remains closed; review the evidence ' +
            'and reconcile the existing receipt rather than rewriting the assertion.',
        };
      }
      return {
        tone: 'warning',
        title: 'Scheduled · receipt pending',
        detail:
          `Manual scheduling is recorded for ${attestedTime} ET and the exact frozen packet. ` +
          'Dispatch is closed. Verify the resulting note ID and authenticated account later to ' +
          'backfill Published. Public indexing may arrive afterward.',
      };
    }
    return {
      tone: 'warning',
      title: 'Scheduled · receipt pending',
      detail:
        'Dispatch and recovery are permanently closed. Verify the existing post by note ID and authenticated account; a public URL is optional.',
    };
  }
  if (job.status === 'verification_pending') {
    return {
      tone: 'warning',
      title: `Verify receipt${job.errorCode ? ` (${job.errorCode})` : ''}`,
      detail: job.nextVerificationAt
        ? `${job.errorMessage || 'The scheduled, ambiguous, or account evidence needs reconciliation.'} Verification is due ${
            new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(job.nextVerificationAt))
          }. Do not publish again.`
        : `${job.errorMessage || 'The scheduled, ambiguous, or account evidence needs reconciliation.'} Do not publish again.`,
    };
  }
  if (job.status === 'verified') {
    return {
      tone: 'warning',
      title: 'Publication acknowledged; Notion reconciliation pending',
      detail:
        'RedNote issued the note ID and the authenticated account owns it. Do not publish again; retry the same receipt to finish Notion backfill.',
    };
  }
  if (job.status === 'failed') {
    return {
      tone: 'error',
      title: `Local browser job failed${job.errorCode ? ` (${job.errorCode})` : ''}`,
      detail: job.errorMessage || 'Review the packet and queue a new job when the issue is resolved.',
    };
  }
  return {
    tone: 'success',
    title: 'Published and reconciled',
    detail: 'The durable note ID and authenticated ownership were verified before Notion was marked Published. Public indexing is tracked separately.',
  };
}

function dashboardState(job: LocalPublishJobSummary | undefined) {
  if (!job) return undefined;
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'claimed' || job.status === 'staged') return 'Scheduling';
  if (job.status === 'submitted' || job.status === 'scheduled') return 'Scheduled/Submitted';
  if (job.status === 'operator_attested') return 'Scheduled/Verifying';
  if (job.status === 'verification_pending' || job.status === 'verified') return 'Verifying';
  if (job.status === 'reconciled') return 'Reconciled';
  return 'Failed';
}

function manualReconciliationStatusCopy(
  reconciliation: ManualReconciliationSummary | undefined,
) {
  if (!reconciliation) return null;
  if (reconciliation.status === 'queued') {
    return {
      tone: 'pending',
      title: 'Manual reconciliation queued',
      detail: reconciliation.nextAttemptAt
        ? `The Mac worker will verify the existing post after ${new Date(
            reconciliation.nextAttemptAt,
          ).toLocaleString()}. It will not click Publish.`
        : 'The Mac worker will verify the existing post. It will not click Publish.',
    };
  }
  if (reconciliation.status === 'verifying') {
    return {
      tone: 'pending',
      title: 'Verifying the existing RedNote post',
      detail:
        'The worker is checking the exact public identity and the canonical metadata available at handoff. Do not publish again.',
    };
  }
  if (reconciliation.status === 'failed') {
    return {
      tone: 'error',
      title: `Manual reconciliation failed${
        reconciliation.errorCode ? ` (${reconciliation.errorCode})` : ''
      }`,
      detail:
        reconciliation.errorMessage ||
        'Check the public post and canonical packet, then retry this request.',
    };
  }
  return {
    tone: 'success',
    title: 'Existing post reconciled',
    detail:
      'The durable RedNote identity was verified and the canonical Notion row was marked Published.',
  };
}

export default function ReadyPostsPanel({
  workspaceId,
  initialNotionPageId,
  onNotionPageIdChange,
}: {
  workspaceId: string;
  initialNotionPageId?: string;
  onNotionPageIdChange?: (notionPageId: string) => void;
}) {
  const [posts, setPosts] = useState<ReadyXhsPost[]>([]);
  const [jobs, setJobs] = useState<LocalPublishJobSummary[]>([]);
  const [attempts, setAttempts] = useState<AdminRednoteAttemptSummary[]>([]);
  const [successAttestationCandidates, setSuccessAttestationCandidates] = useState<
    OperatorSuccessAttestationEvidence[]
  >([]);
  const [batches, setBatches] = useState<PublishBatch[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [recoveryBusyJobId, setRecoveryBusyJobId] = useState('');
  const [attestationBusyJobId, setAttestationBusyJobId] = useState('');
  const [manualSchedulingBusyItemId, setManualSchedulingBusyItemId] = useState('');
  const [receiptBusyJobId, setReceiptBusyJobId] = useState('');
  const [receiptInputs, setReceiptInputs] = useState<Record<string, string>>({});
  const [receiptConfirmed, setReceiptConfirmed] = useState<Record<string, boolean>>({});
  const [receiptErrors, setReceiptErrors] = useState<Record<string, string>>({});
  const [reconciliations, setReconciliations] = useState<ExternalReconciliationSummary[]>([]);
  const [reconciliationError, setReconciliationError] = useState('');
  const [manualReconciliations, setManualReconciliations] = useState<
    ManualReconciliationSummary[]
  >([]);
  const [manualReconciliationError, setManualReconciliationError] = useState('');
  const [showManualReconciliation, setShowManualReconciliation] = useState(false);
  const [manualPublicPost, setManualPublicPost] = useState('');
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualHandlingMode, setManualHandlingMode] =
    useState<ManualHandlingMode>('scheduled');
  const [manualHandlingSubmitting, setManualHandlingSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState(initialNotionPageId ?? '');
  const [loading, setLoading] = useState(true);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [mobileHandoffStatus, setMobileHandoffStatus] =
    useState<MobileHandoffStatus | null>(null);
  const [mobileShareStatus, setMobileShareStatus] =
    useState<MobileHandoffStatus | null>(null);
  const [mobileHandoffBusy, setMobileHandoffBusy] = useState(false);
  const [preparedMobileHandoff, setPreparedMobileHandoff] =
    useState<PreparedMobileHandoff | null>(null);
  const [mobileHandoffClock, setMobileHandoffClock] = useState(() => Date.now());
  const [creatorOpenStatus, setCreatorOpenStatus] = useState<MobileHandoffStatus | null>(null);
  const [finalTitle, setFinalTitle] = useState('');
  const [finalCaption, setFinalCaption] = useState('');
  const [finalTags, setFinalTags] = useState('');
  const [mediaKey, setMediaKey] = useState('');
  const copyRequestRef = useRef(0);
  const selectedPostIdRef = useRef<string>();
  const idempotencyKeysRef = useRef<Record<string, string>>({});
  const reconciliationKeysRef = useRef<Record<string, string>>({});
  const attestationKeysRef = useRef<Record<string, string>>({});
  const manualSchedulingKeysRef = useRef<Record<string, string>>({});
  const receiptKeysRef = useRef<Record<string, string>>({});
  const manualHandlingKeysRef = useRef<Record<string, string>>({});
  const preparedDownloadUrlsRef = useRef<string[]>([]);
  const releasePreparedDownloadUrls = useCallback(() => {
    for (const url of preparedDownloadUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    preparedDownloadUrlsRef.current = [];
  }, []);
  useEffect(() => releasePreparedDownloadUrls, [releasePreparedDownloadUrls]);

  const selected = useMemo(
    () => posts.find((post) => post.id === selectedId) ?? posts[0],
    [posts, selectedId],
  );
  const requestedPostMissing = !loading && requestedReadyPostIsMissing(
    posts,
    initialNotionPageId,
  );
  const activeUnpublishedPosts = useMemo(
    () => posts.filter((post) =>
      post.candidateKind === 'active_unpublished' &&
      publicationOperationalTruth(
        post,
        displayedLocalPublishJob(jobs, post.id),
        manualReconciliations.find((item) => item.notionPageId === post.id),
      ).state !== 'published'),
    [jobs, manualReconciliations, posts],
  );
  const pendingPreparedBatch = batches.find((batch) =>
    batch.kind === 'on_demand'
    && batch.status === 'pending_approval'
    && batch.items.some((item) => item.notionPageId === selected?.id));
  const pendingBootstrapBatch = batches.find((batch) =>
    batch.kind === 'bootstrap' && batch.status === 'pending_approval');
  const pendingBatch = pendingPreparedBatch ?? pendingBootstrapBatch;
  const approvedBatch = batches.find((batch) =>
    batch.status === 'approved'
    && (
      batch.kind === 'bootstrap'
      || (
        batch.kind === 'on_demand'
        && batch.items.some((item) => item.notionPageId === selected?.id)
      )
    ));
  const supersededBatches = batches
    .filter((batch) => batch.kind === 'bootstrap' && batch.status === 'superseded')
    .slice(0, 3);
  const recoverableBatches = batches.filter((batch) =>
    batch.items.some((item) => item.recoveryEvidence));
  const manualUrlError = manualPublicPostError(manualPublicPost);
  const packetReadyPosts = useMemo(
    () => posts.filter((post) =>
      post.candidateKind === 'packet_ready' &&
      publicationOperationalTruth(
        post,
        displayedLocalPublishJob(jobs, post.id),
        manualReconciliations.find((item) => item.notionPageId === post.id),
      ).state !== 'published'),
    [jobs, manualReconciliations, posts],
  );
  const publishedPosts = useMemo(
    () => posts.filter((post) =>
      publicationOperationalTruth(
        post,
        displayedLocalPublishJob(jobs, post.id),
        manualReconciliations.find((item) => item.notionPageId === post.id),
      ).state === 'published'),
    [jobs, manualReconciliations, posts],
  );
  const movTrialPosts = useMemo(
    () => posts.filter((post) => post.candidateKind === 'mov_compatibility_trial'),
    [posts],
  );
  const receiptPendingJobs = useMemo(
    () => receiptPendingLocalPublishJobs(jobs),
    [jobs],
  );
  const mediaPreview = useMemo(() => {
    if (!selected) {
      return {
        choices: [] as ReadyPostMediaChoice[],
        rejectedUrls: [] as string[],
        thumbnailUrl: undefined,
      };
    }
    return readyPostMediaPreview(selected);
  }, [preparedMobileHandoff, selected]);
  const mediaChoices = mediaPreview.choices;
  const selectedMedia = mediaChoices.find(
    (choice) => `${choice.compatibilityTrial ?? choice.type}:${choice.index}` === mediaKey,
  ) ?? mediaChoices[0];
  const isMovCompatibilityTrial = selectedMedia?.compatibilityTrial === 'unverified_mov';
  const movTrialIsEligible = selected ? isMovCompatibilityTrialEligible(selected) : false;
  const currentJob = selected
    ? displayedLocalPublishJob(jobs, selected.id)
    : undefined;
  const handoffAttempt = useMemo(() => {
    if (!selected || !currentJob) return undefined;
    const durableAttempt = attempts.find((attempt) =>
      isEligibleAdminRednoteAttempt(attempt, currentJob.id));
    if (!durableAttempt) return undefined;
    for (const batch of batches) {
      if (!['approved', 'partially_approved'].includes(batch.status)) continue;
      const item = batch.items.find((candidate) =>
        candidate.notionPageId === selected.id
        && candidate.localPublishJobId === currentJob.id
        && !['failed', 'invalidated', 'reconciled'].includes(candidate.state));
      if (item) {
        return {
          durableAttempt,
          batchId: batch.id,
          manifestHash: batch.manifestHash,
          item,
        };
      }
    }
    return undefined;
  }, [attempts, batches, currentJob, selected]);
  const handoffSnapshot = handoffAttempt?.item.snapshot;
  const handoffMedia = handoffSnapshot?.media?.length
    ? handoffSnapshot.media
    : handoffSnapshot
      ? [{
          identity: `${handoffSnapshot.mediaType}:${handoffSnapshot.mediaIndex}`,
          type: handoffSnapshot.mediaType,
          url: handoffSnapshot.mediaUrl,
        }]
      : [];
  const handoffTitle = handoffSnapshot?.title ?? '';
  const handoffCaption = handoffSnapshot?.caption ?? '';
  const handoffTags = handoffSnapshot?.tags ?? [];
  const handoffMissingTags = getMissingTags(handoffTags, handoffCaption);
  const preparedMissingTags = preparedMobileHandoff
    ? getMissingTags(
      preparedMobileHandoff.identity.tags,
      preparedMobileHandoff.identity.caption,
    )
    : handoffMissingTags;
  const showHandoffTitleCopy = shouldOfferTitleCopy(handoffTitle, handoffCaption);
  const handoffVideoIndex = handoffMedia.findIndex((media) => media.type === 'video');
  useEffect(() => {
    if (!selected) return;
    const key = mobileHandoffStorageKey(workspaceId, selected.id);
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) {
        setPreparedMobileHandoff(null);
        setMobileHandoffStatus(null);
        setMobileShareStatus(null);
        setCreatorOpenStatus(null);
        setCopyStatus(null);
        return;
      }
      const identity = JSON.parse(raw) as MobileHandoffIdentity;
      if (
        identity.workspaceId !== workspaceId
        || identity.postId !== selected.id
        || identity.preparation !== 'prepared'
      ) {
        setPreparedMobileHandoff(null);
        setMobileHandoffStatus(null);
        setMobileShareStatus(null);
        setCreatorOpenStatus(null);
        setCopyStatus(null);
        return;
      }
      setPreparedMobileHandoff({ identity, files: [], downloadUrls: [] });
      setMobileHandoffStatus({
        tone: 'warning',
        message:
          `Restored the exact attempt ${identity.durableAttemptId} at source revision ` +
          `${identity.sourceRevision}. Re-prepare the files before sharing on this page.`,
      });
      if (identity.share !== 'not_attempted') {
        setMobileShareStatus({
          tone: identity.share === 'completed' ? 'success' : 'warning',
          message: identity.share === 'completed'
            ? 'The browser share request previously completed for this exact attempt. Verify every numbered asset and the text in Rednote; publication still requires manual Creator action and receipt reconciliation.'
            : 'File sharing was previously unavailable or failed for this exact attempt. Re-prepare files before trying again.',
        });
      } else {
        setMobileShareStatus(null);
      }
      if (identity.creator === 'opening_attempted') {
        setCreatorOpenStatus({
          tone: 'warning',
          message: 'Opening RedNote Creator was previously attempted. App opening cannot be confirmed and did not publish.',
        });
      } else {
        setCreatorOpenStatus(null);
      }
      if (identity.clipboard !== 'not_attempted') {
        setCopyStatus({
          ok: identity.clipboard === 'succeeded',
          message: identity.clipboard === 'succeeded'
            ? 'Clipboard copy was previously completed for this exact attempt.'
            : 'Clipboard copy previously failed; select the frozen text and copy manually.',
        });
      } else {
        setCopyStatus(null);
      }
    } catch {
      setPreparedMobileHandoff(null);
      setMobileHandoffStatus(null);
      setMobileShareStatus(null);
      setCreatorOpenStatus(null);
      setCopyStatus(null);
    }
  }, [selected?.id, workspaceId]);
  const manualHandoffEligible = Boolean(
    selected
    && currentJob
    && handoffAttempt
    && handoffSnapshot
    && isManualHandoffEligible({
      destination: handoffSnapshot.platform,
      studioStatus: selected.status,
      publishPacketReady: selected.publishPacketReady,
      readinessBlockers: selected.automationBlockers,
      workspace: {
        requestedId: workspaceId,
        packetId: batches.find((batch) =>
          batch.id === handoffAttempt.batchId)?.workspaceId ?? '',
      },
      postId: selected.id,
      sourceRevision: selected.lastEditedTime,
      packet: {
        identity: handoffAttempt.item.itemHash,
        postId: handoffSnapshot.notionPageId,
        sourceRevision: handoffSnapshot.notionLastEditedTime,
        mediaIdentities: handoffMedia.map((media) => media.identity),
        expectedMediaIdentities: handoffMedia.map((media) => media.identity),
      },
      attempt: {
        identity: handoffAttempt.durableAttempt.id,
        sourceLocalPublishJobId:
          handoffAttempt.durableAttempt.sourceLocalPublishJobId ?? '',
        payloadDigest: handoffAttempt.durableAttempt.payloadDigest ?? '',
        payloadRevision: handoffAttempt.durableAttempt.payloadRevision ?? '',
        eligible: isEligibleAdminRednoteAttempt(
          handoffAttempt.durableAttempt,
          currentJob.id,
        ),
      },
      localPublishJobId: currentJob.id,
    }),
  );
  const preparedIdentityCurrent = Boolean(
    preparedMobileHandoff
    && selected
    && currentJob
    && handoffAttempt
    && handoffSnapshot
    && preparedMobileHandoff.identity.workspaceId === workspaceId
    && preparedMobileHandoff.identity.postId === selected.id
    && preparedMobileHandoff.identity.sourceRevision === selected.lastEditedTime
    && preparedMobileHandoff.identity.localPublishJobId === currentJob.id
    && preparedMobileHandoff.identity.durableAttemptId === handoffAttempt.durableAttempt.id
    && preparedMobileHandoff.identity.payloadDigest === handoffAttempt.durableAttempt.payloadDigest
    && preparedMobileHandoff.identity.payloadRevision === handoffAttempt.durableAttempt.payloadRevision
    && preparedMobileHandoff.identity.batchId === handoffAttempt.batchId
    && preparedMobileHandoff.identity.manifestHash === handoffAttempt.manifestHash
    && preparedMobileHandoff.identity.itemHash === handoffAttempt.item.itemHash
    && preparedMobileHandoff.identity.title === handoffSnapshot.title
    && preparedMobileHandoff.identity.caption === handoffSnapshot.caption
    && preparedMobileHandoff.identity.tags.length === handoffSnapshot.tags.length
    && preparedMobileHandoff.identity.tags.every(
      (tag, index) => tag === handoffSnapshot.tags[index],
    )
    && preparedMobileHandoff.identity.text === formatRednoteHandoffText(
      handoffSnapshot.caption,
      handoffSnapshot.tags,
    )
    && preparedMobileHandoff.identity.mediaIdentities.length === handoffMedia.length
    && preparedMobileHandoff.identity.mediaIdentities.every(
      (identity, index) => identity === handoffMedia[index]?.identity,
    )
    && preparedMobileHandoff.files.length === handoffMedia.length
    && manualHandoffEligible,
  );
  const preparedAuthorityFresh = Boolean(
    preparedMobileHandoff
    && isPreparedHandoffFresh(
      preparedMobileHandoff.identity.validatedAt,
      mobileHandoffClock,
    ),
  );
  const preparedActionsAvailable = Boolean(
    preparedIdentityCurrent
    && preparedAuthorityFresh,
  );
  const preparedValidatedAt = preparedMobileHandoff?.identity.validatedAt;
  const preparedFileCount = preparedMobileHandoff?.files.length ?? 0;
  useEffect(() => {
    if (!preparedMobileHandoff || preparedMobileHandoff.files.length === 0) return;
    const expiresAt =
      preparedMobileHandoff.identity.validatedAt + PREPARED_HANDOFF_FRESHNESS_MS;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setMobileHandoffClock(Date.now());
      return;
    }
    const timer = window.setTimeout(
      () => setMobileHandoffClock(Date.now()),
      remaining,
    );
    return () => window.clearTimeout(timer);
  }, [preparedFileCount, preparedMobileHandoff, preparedValidatedAt]);
  useEffect(() => {
    if (!preparedMobileHandoff || preparedMobileHandoff.files.length === 0) return;
    if (preparedIdentityCurrent && preparedAuthorityFresh) return;
    const expired = !preparedAuthorityFresh;
    releasePreparedDownloadUrls();
    setPreparedMobileHandoff(null);
    try {
      window.sessionStorage.removeItem(
        mobileHandoffStorageKey(workspaceId, preparedMobileHandoff.identity.postId),
      );
    } catch {
      // Session storage is an enhancement.
    }
    setMobileHandoffStatus({
      tone: 'error',
      message: expired
        ? 'The two-minute preparation window expired. Prepare and revalidate the exact current attempt again.'
        : 'The prepared packet changed while this page was open. Prepare the exact current attempt again.',
    });
    setMobileShareStatus(null);
    setCreatorOpenStatus(null);
    setCopyStatus(null);
  }, [
    preparedAuthorityFresh,
    preparedIdentityCurrent,
    preparedMobileHandoff,
    releasePreparedDownloadUrls,
    workspaceId,
  ]);
  const currentJobStatus = jobStatusCopy(currentJob, selected);
  const manualSchedulingCandidate = useMemo<ManualSchedulingAttestationEvidence | undefined>(
    () => directManualSchedulingCandidate(selected, batches, jobs),
    [batches, jobs, selected],
  );
  const currentManualReconciliation = selected
    ? manualReconciliations.find(
        (reconciliation) => reconciliation.notionPageId === selected.id,
      )
    : undefined;
  const currentManualStatus = manualReconciliationStatusCopy(
    currentManualReconciliation,
  );
  const currentManualHandling = selected?.manualHandling;
  const currentTruth = selected
    ? publicationOperationalTruth(selected, currentJob, currentManualReconciliation)
    : undefined;
  const selectedIsPublished = currentTruth?.state === 'published';
  const hasActiveManualReconciliation = Boolean(
    currentManualReconciliation &&
      (currentManualReconciliation.status === 'queued' ||
        currentManualReconciliation.status === 'verifying'),
  );
  const hasActiveJob = Boolean(currentJob && isActiveLocalPublishJob(currentJob));
  const hasLiveManualOwnership = hasLiveUnsafeAutomationOwnership(currentJob);
  const canStartManualReconciliation =
    Boolean(
      currentManualHandling?.receiptStatus === 'pending'
      && (!currentJob || currentJob.status === 'failed' || currentJob.status === 'queued'),
    );
  const reviewedTags = tagsFromInput(finalTags);
  const timing = selected ? publishTiming(selected) : null;
  const selectedSchedule = selected
    ? getEditorialScheduleDisplay(selected.scheduledDate)
    : null;
  selectedPostIdRef.current = selected?.id;

  const loadPosts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const path = '/admin/api/ready-posts';
      const response = await adminApiFetch(workspaceId, path, { cache: 'no-store' });
      const data = await responseJson<ReadyXhsPostsResponse & ApiError>(
        response,
        `GET ${path}`,
      );
      if (!response.ok) throw new Error(data.error || 'Failed to load ready posts');
      setPosts(data.posts);
      setWarnings(data.warnings);
      setSelectedId((current) =>
        resolveReadyPostSelection(data.posts, current, initialNotionPageId),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load ready posts');
    } finally {
      setLoading(false);
    }
  }, [initialNotionPageId, workspaceId]);

  const loadBatches = useCallback(async () => {
    try {
      const path = '/admin/api/publish-batches';
      const response = await adminApiFetch(workspaceId, path, { cache: 'no-store' });
      const data = await responseJson<PublishBatchesResponse>(response, `GET ${path}`);
      if (!response.ok) throw new Error(data.error || 'Failed to load publish batches');
      setBatches(data.batches);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load publish batches');
    }
  }, [workspaceId]);

  const loadJobs = useCallback(async (showError = false) => {
    try {
      const path = '/admin/api/local-publish-jobs';
      const response = await adminApiFetch(workspaceId, path, { cache: 'no-store' });
      const data = await responseJson<LocalJobsResponse>(response, `GET ${path}`);
      if (!response.ok) throw new Error(data.error || 'Failed to load local publish jobs');
      const parsed = parseAdminLocalJobsResponse(data);
      setJobs(parsed.jobs);
      setAttempts(parsed.attempts);
      setSuccessAttestationCandidates(parsed.successAttestationCandidates);
    } catch (loadError) {
      if (showError) {
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load local publish jobs',
        );
      }
    }
  }, [workspaceId]);

  const loadReconciliations = useCallback(async () => {
    try {
      const path = '/admin/api/external-post-reconciliations';
      const response = await adminApiFetch(workspaceId, path, { cache: 'no-store' });
      const data = await responseJson<ExternalReconciliationsResponse>(
        response,
        `GET ${path}`,
      );
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load external reconciliations');
      }
      setReconciliations(data.reconciliations);
      setReconciliationError('');
    } catch (loadError) {
      setReconciliationError(
        loadError instanceof Error
          ? loadError.message
          : 'Failed to load external reconciliations',
      );
    }
  }, [workspaceId]);

  const loadManualReconciliations = useCallback(async (showError = false) => {
    try {
      const path = '/admin/api/manual-reconciliations';
      const response = await adminApiFetch(workspaceId, path, { cache: 'no-store' });
      const data = await responseJson<ManualReconciliationsResponse>(
        response,
        `GET ${path}`,
      );
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load manual reconciliations');
      }
      setManualReconciliations(data.reconciliations);
      setManualReconciliationError('');
    } catch (loadError) {
      if (showError) {
        setManualReconciliationError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load manual reconciliations',
        );
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadPosts();
    void loadJobs(true);
    void loadReconciliations();
    void loadManualReconciliations(true);
    void loadBatches();
  }, [loadBatches, loadJobs, loadManualReconciliations, loadPosts, loadReconciliations]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadJobs();
      void loadReconciliations();
      void loadManualReconciliations();
      void loadBatches();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadBatches, loadJobs, loadManualReconciliations, loadReconciliations]);

  useEffect(() => {
    setFinalTitle(selected?.headline ?? '');
    setFinalCaption(selected?.caption ?? '');
    setFinalTags(selected?.tags.join(', ') ?? '');
    const firstChoice = selected?.videoUrls.length
      ? 'video:0'
      : selected?.compatibilityTrialVideoUrls?.length
        ? 'unverified_mov:0'
        : selected?.imageUrls.length
          ? 'image:0'
          : '';
    setMediaKey(firstChoice);
    const preserveHandoffOutcomes = Boolean(
      selected
      && preparedMobileHandoff?.identity.postId === selected.id,
    );
    if (!preserveHandoffOutcomes) {
      setCopyStatus(null);
      setMobileHandoffStatus(null);
      setMobileShareStatus(null);
      setCreatorOpenStatus(null);
    }
    setMobileHandoffBusy(false);
    setShowManualReconciliation(false);
    setManualPublicPost('');
    setManualConfirmed(false);
    setManualHandlingMode('scheduled');
  }, [selected]);

  async function markSelectedHandledManually() {
    if (
      !selected
      || !manualHandoffEligible
      || currentManualHandling
      || selectedIsPublished
    ) return;
    const idempotencyKey =
      manualHandlingKeysRef.current[selected.id] ?? crypto.randomUUID();
    manualHandlingKeysRef.current[selected.id] = idempotencyKey;
    setManualHandlingSubmitting(true);
    setError('');
    try {
      const path = '/admin/api/manual-post-handlings';
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          notionPageId: selected.id,
          expectedLastEditedTime: selected.lastEditedTime,
          mode: manualHandlingMode,
        }),
      });
      const data = await responseJson<ManualPostHandlingResponse & ApiError>(
        response,
        `POST ${path}`,
      );
      if (!response.ok) {
        throw new Error(data.error || 'Failed to record manual handling');
      }
      delete manualHandlingKeysRef.current[selected.id];
      setPosts((current) => current.map((post) =>
        post.id === selected.id
          ? { ...post, manualHandling: data.handling }
          : post));
      await loadJobs();
    } catch (handlingError) {
      setError(
        handlingError instanceof Error
          ? handlingError.message
          : 'Failed to record manual handling',
      );
    } finally {
      setManualHandlingSubmitting(false);
    }
  }

  async function prepareMobileHandoff() {
    if (
      !selected
      || !currentJob
      || !handoffAttempt
      || !handoffSnapshot
      || handoffMedia.length === 0
      || mobileHandoffBusy
      || selectedIsPublished
      || hasLiveManualOwnership
      || !manualHandoffEligible
    ) return;

    const selectedPostId = selected.id;
    const attemptId = currentJob.id;
    const durableAttemptId = handoffAttempt.durableAttempt.id;
    const payloadDigest = handoffAttempt.durableAttempt.payloadDigest!;
    const payloadRevision = handoffAttempt.durableAttempt.payloadRevision!;
    const batchId = handoffAttempt.batchId;
    const manifestHash = handoffAttempt.manifestHash;
    const itemHash = handoffAttempt.item.itemHash;
    const frozenSnapshot = handoffSnapshot;
    const orderedMedia = handoffMedia.map((media) => ({ ...media }));
    const text = formatRednoteHandoffText(
      frozenSnapshot.caption,
      frozenSnapshot.tags,
    );
    setMobileHandoffBusy(true);
    setMobileShareStatus(null);
    setMobileHandoffStatus({
      tone: 'warning',
      message: 'Revalidating the exact source revision and ordered media…',
    });

    try {
      const [postsResponse, jobsResponse, batchesResponse] = await Promise.all([
        adminApiFetch(workspaceId, '/admin/api/ready-posts', { cache: 'no-store' }),
        adminApiFetch(workspaceId, '/admin/api/local-publish-jobs', { cache: 'no-store' }),
        adminApiFetch(workspaceId, '/admin/api/publish-batches', { cache: 'no-store' }),
      ]);
      const [postsData, jobsData, batchesData] = await Promise.all([
        responseJson<ReadyXhsPostsResponse & ApiError>(
          postsResponse,
          'GET /admin/api/ready-posts',
        ),
        responseJson<LocalJobsResponse>(
          jobsResponse,
          'GET /admin/api/local-publish-jobs',
        ),
        responseJson<PublishBatchesResponse>(
          batchesResponse,
          'GET /admin/api/publish-batches',
        ),
      ]);
      if (!postsResponse.ok) {
        throw new Error(postsData.error || 'Could not revalidate this packet');
      }
      if (!jobsResponse.ok) {
        throw new Error(jobsData.error || 'Could not revalidate this attempt');
      }
      if (!batchesResponse.ok) {
        throw new Error(batchesData.error || 'Could not revalidate this packet manifest');
      }
      const current = postsData.posts.find((post) => post.id === selectedPostId);
      if (!current) {
        throw new Error('This exact Post is no longer available. Refresh before preparing it.');
      }
      const currentJobs = parseAdminLocalJobsResponse(jobsData).jobs;
      const currentAttempts = parseAdminLocalJobsResponse(jobsData).attempts;
      const currentAttempt = currentJobs.find((job) => job.id === attemptId);
      const currentDurableAttempt = currentAttempts.find((attempt) =>
        attempt.id === durableAttemptId
        && isEligibleAdminRednoteAttempt(attempt, attemptId)
        && attempt.payloadDigest === payloadDigest
        && attempt.payloadRevision === payloadRevision);
      const currentBatch = batchesData.batches.find((batch) =>
        batch.id === batchId
        && batch.manifestHash === manifestHash
        && ['approved', 'partially_approved'].includes(batch.status));
      const currentItem = currentBatch?.items.find((item) =>
        item.itemHash === itemHash
        && item.localPublishJobId === attemptId
        && item.notionPageId === selectedPostId
        && !['failed', 'invalidated', 'reconciled'].includes(item.state));
      const currentHandoffEligible = Boolean(
        currentDurableAttempt
        && currentItem
        && isManualHandoffEligible({
          destination: currentItem.snapshot.platform,
          studioStatus: current.status,
          publishPacketReady: current.publishPacketReady,
          readinessBlockers: current.automationBlockers,
          workspace: {
            requestedId: workspaceId,
            packetId: currentBatch?.workspaceId ?? '',
          },
          postId: current.id,
          sourceRevision: current.lastEditedTime,
          packet: {
            identity: currentItem.itemHash,
            postId: currentItem.snapshot.notionPageId,
            sourceRevision: currentItem.snapshot.notionLastEditedTime,
            mediaIdentities: (
              currentItem.snapshot.media?.map((media) => media.identity)
              ?? [`${currentItem.snapshot.mediaType}:${currentItem.snapshot.mediaIndex}`]
            ),
            expectedMediaIdentities: orderedMedia.map((media) => media.identity),
          },
          attempt: {
            identity: currentDurableAttempt.id,
            sourceLocalPublishJobId:
              currentDurableAttempt.sourceLocalPublishJobId ?? '',
            payloadDigest: currentDurableAttempt.payloadDigest ?? '',
            payloadRevision: currentDurableAttempt.payloadRevision ?? '',
            eligible: isEligibleAdminRednoteAttempt(
              currentDurableAttempt,
              attemptId,
            ),
          },
          localPublishJobId: attemptId,
        }),
      );
      if (
        !currentAttempt
        || !currentDurableAttempt
        || !currentItem
        || !currentHandoffEligible
        || hasLiveUnsafeAutomationOwnership(currentAttempt)
        || current.status.trim().toLowerCase() === 'published'
        || current.candidateKind !== 'packet_ready'
        || current.lastEditedTime !== frozenSnapshot.notionLastEditedTime
      ) {
        throw new Error(
          'This attempt, frozen packet, source revision, or ownership state changed. Refresh and review the exact attempt again.',
        );
      }

      const files = await prepareOrderedMediaFiles(frozenSnapshot.title, orderedMedia);
      const shareData: ShareData = {
        title: frozenSnapshot.title,
        text,
        files,
      };
      let shareable = false;
      try {
        shareable = canSharePreparedPacket(navigator, shareData);
      } catch {
        shareable = false;
      }
      const validatedAt = Date.now();
      const downloadUrls: string[] = [];
      try {
        for (const file of files) {
          downloadUrls.push(URL.createObjectURL(file));
        }
      } catch (error) {
        for (const url of downloadUrls) URL.revokeObjectURL(url);
        throw error;
      }
      const identity: MobileHandoffIdentity = {
        workspaceId,
        postId: selectedPostId,
        sourceRevision: frozenSnapshot.notionLastEditedTime,
        localPublishJobId: attemptId,
        durableAttemptId,
        payloadDigest,
        payloadRevision,
        batchId,
        manifestHash,
        itemHash,
        mediaIdentities: orderedMedia.map((media) => media.identity),
        title: frozenSnapshot.title,
        caption: frozenSnapshot.caption,
        tags: [...frozenSnapshot.tags],
        text,
        validatedAt,
        preparation: 'prepared',
        shareable,
        clipboard: 'not_attempted',
        share: shareable ? 'not_attempted' : 'unsupported',
        creator: 'not_attempted',
      };
      releasePreparedDownloadUrls();
      preparedDownloadUrlsRef.current = downloadUrls;
      setMobileHandoffClock(validatedAt);
      setPreparedMobileHandoff({ identity, files, downloadUrls });
      try {
        window.sessionStorage.setItem(
          mobileHandoffStorageKey(workspaceId, selectedPostId),
          JSON.stringify(identity),
        );
      } catch {
        // Session storage is an enhancement; the in-memory identity remains authoritative.
      }
      setMobileHandoffStatus({
        tone: shareable ? 'success' : 'warning',
        message: shareable
          ? `${files.length} ordered assets prepared and revalidated for two minutes. Tap “Share prepared packet” as a separate gesture. Nothing was copied or published.`
          : `${files.length} ordered assets prepared and revalidated for two minutes. This browser cannot share the complete packet through its share sheet; use the prepared numbered downloads, separate copy controls, and then open Creator.`,
      });
    } catch (handoffError) {
      setMobileHandoffStatus({
        tone: 'error',
        message: handoffError instanceof Error
          ? handoffError.message
          : 'The packet could not be prepared. Refresh and review it again.',
      });
    } finally {
      setMobileHandoffBusy(false);
    }
  }

  function persistMobileHandoffIdentity(
    patch: Partial<Pick<MobileHandoffIdentity, 'clipboard' | 'share' | 'creator'>>,
  ) {
    setPreparedMobileHandoff((current) => {
      if (!current) return current;
      const updated = {
        ...current,
        identity: { ...current.identity, ...patch },
      };
      try {
        window.sessionStorage.setItem(
          mobileHandoffStorageKey(updated.identity.workspaceId, updated.identity.postId),
          JSON.stringify(updated.identity),
        );
      } catch {
        // Session storage is an enhancement.
      }
      return updated;
    });
  }

  function sharePreparedMobileHandoff() {
    const prepared = preparedMobileHandoff;
    if (
      !prepared
      || prepared.files.length === 0
      || !preparedIdentityCurrent
      || !isPreparedHandoffFresh(prepared.identity.validatedAt)
    ) {
      setMobileHandoffClock(Date.now());
      persistMobileHandoffIdentity({ share: 'failed' });
      setMobileShareStatus({
        tone: 'error',
        message: 'The prepared authority is unavailable or expired. Prepare and revalidate the complete packet again before sharing.',
      });
      return;
    }
    if (!navigator.share || !navigator.canShare) {
      persistMobileHandoffIdentity({ share: 'unsupported' });
      setMobileShareStatus({
        tone: 'warning',
        message: 'File sharing is unavailable in this browser. Use the numbered downloads and copy controls.',
      });
      return;
    }
    const shareData: ShareData = {
      title: prepared.identity.title,
      text: prepared.identity.text,
      files: prepared.files,
    };
    let shareable = false;
    try {
      shareable = canSharePreparedPacket(navigator, shareData);
    } catch {
      shareable = false;
    }
    if (!shareable) {
      persistMobileHandoffIdentity({ share: 'unsupported' });
      setMobileShareStatus({
        tone: 'warning',
        message: 'This browser cannot share the complete prepared file set. No files were omitted; use the numbered downloads.',
      });
      return;
    }
    setMobileShareStatus({
      tone: 'warning',
      message: 'Opening the share sheet for the complete ordered packet. Opening it does not publish.',
    });
    void navigator.share(shareData).then(() => {
      persistMobileHandoffIdentity({ share: 'completed' });
      setMobileShareStatus({
        tone: 'success',
        message: `The browser share request completed with the prepared packet of ${prepared.files.length} numbered assets. Verify the text and every numbered asset in Rednote before publishing.`,
      });
    }).catch((error: unknown) => {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      persistMobileHandoffIdentity({ share: 'failed' });
      setMobileShareStatus({
        tone: 'warning',
        message: aborted
          ? 'The share sheet was closed. Nothing was published; use the numbered downloads or try again.'
          : 'The share sheet could not open. No files were omitted or published; use the numbered downloads.',
      });
    });
  }

  function recordCreatorOpening(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (
      !preparedActionsAvailable
      || !preparedMobileHandoff
      || !isPreparedHandoffFresh(preparedMobileHandoff.identity.validatedAt)
    ) {
      event.preventDefault();
      setMobileHandoffClock(Date.now());
      setCreatorOpenStatus({
        tone: 'error',
        message: 'Prepare and revalidate the exact current packet before opening Creator.',
      });
      return;
    }
    setCreatorOpenStatus({
      tone: 'warning',
      message: 'Opening RedNote Creator was attempted. The browser cannot confirm app opening, and this did not publish.',
    });
    setPreparedMobileHandoff((current) => {
      if (!current) return current;
      const updated = {
        ...current,
        identity: { ...current.identity, creator: 'opening_attempted' as const },
      };
      try {
        window.sessionStorage.setItem(
          mobileHandoffStorageKey(updated.identity.workspaceId, updated.identity.postId),
          JSON.stringify(updated.identity),
        );
      } catch {
        // Session storage is an enhancement.
      }
      return updated;
    });
  }

  async function queueSelected() {
    if (!selected || selected.candidateKind !== 'packet_ready' || !selectedMedia) return;
    const confirmed = window.confirm(
      isMovCompatibilityTrial
        ? `Queue "${finalTitle.trim()}" as an UNVERIFIED MOV COMPATIBILITY STAGING TRIAL?\n\n` +
          'RedNote compatibility is not certified. The Mac worker may only stage the MOV. ' +
          `If Creator accepts staging, a human must still type PUBLISH <jobId> before any Publish click. ` +
          'A staging failure must be reported without clicking Publish.'
        : `Queue "${finalTitle.trim()}" for the local RedNote browser?\n\n` +
          'The Mac worker may stage this packet, but a human still reviews and approves the final publish in Creator. Queueing does not mark it Published.',
    );
    if (!confirmed) return;

    const idempotencyKey = idempotencyKeysRef.current[selected.id] ?? crypto.randomUUID();
    idempotencyKeysRef.current[selected.id] = idempotencyKey;
    setQueueing(true);
    setError('');
    try {
      const path = '/admin/api/local-publish-jobs';
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          notionPageId: selected.id,
          lastEditedTime: selected.lastEditedTime,
          confirmed: true,
          ...(isMovCompatibilityTrial ? { compatibilityTrialConfirmed: true } : {}),
          title: finalTitle,
          caption: finalCaption,
          tags: reviewedTags,
          media: {
            type: selectedMedia.type,
            index: selectedMedia.index,
          },
        }),
      });
      const data = await responseJson<LocalJobResponse>(response, `POST ${path}`);
      if (!response.ok) throw new Error(data.error || 'Failed to queue local publish job');
      delete idempotencyKeysRef.current[selected.id];
      setJobs((current) => [
        data.job,
        ...current.filter((job) => job.id !== data.job.id),
      ]);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : 'Failed to queue job');
      void loadJobs();
    } finally {
      setQueueing(false);
    }
  }

  async function updateBatch(action: 'prepare' | 'create' | 'approve') {
      setBatchBusy(true);
      setError('');
      try {
        const path = '/admin/api/publish-batches';
        const response = await adminApiFetch(workspaceId, path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'prepare'
            ? {
                action,
                notionPageId: selected?.id,
              }
            : action === 'create'
              ? {
                action,
                kind: 'bootstrap',
                notionPageIds: selected ? [selected.id] : [],
              }
              : {
                action,
                batchId: pendingBatch?.id,
                manifestHash: pendingBatch?.manifestHash,
                confirmed: true,
              }),
        });
        const data = await responseJson<PublishBatchesResponse>(response, `POST ${path}`);
        if (!response.ok) throw new Error(data.error || 'Failed to update publish batch');
        await Promise.all([loadBatches(), loadJobs()]);
      } catch (batchError) {
        setError(batchError instanceof Error ? batchError.message : 'Failed to update batch');
      } finally {
        setBatchBusy(false);
    }
  }

  async function recoverApprovedJob(
    evidence: RednotePublishJobRecoveryEvidence,
    title: string,
    repairMissingAttemptLineage = false,
  ) {
    const recoveryAction = readyPostRecoveryAction(
      evidence,
      repairMissingAttemptLineage,
    );
    const confirmed = window.confirm(
      `${repairMissingAttemptLineage ? 'Repair attempt lineage for' : 'Recover'} ` +
      `the exact already-approved job for "${title}"?\n\n` +
      recoveryAction.failureDetail +
      `Job ${evidence.jobId}\n` +
      `Batch ${evidence.batchId}\n` +
      `Item ${evidence.itemId}\n` +
      `Manifest ${evidence.manifestHash}\n` +
      `Item hash ${evidence.itemHash}\n` +
      `Source revision ${evidence.snapshotRevision}\n\n` +
      `Terminal claim generation ${evidence.claimAttempts}\n` +
      (evidence.latestAuditedClaimAttempts !== undefined
        ? `Latest audited generation ${evidence.latestAuditedClaimAttempts}\n\n`
        : '\n') +
      'This preserves the same job, frozen snapshot, hashes, publish time, and original approval. ' +
      'It creates one fresh approved worker attempt generation without approving again or ' +
      'creating a replacement local job. ' +
      (repairMissingAttemptLineage
        ? 'The immutable original recovery audit and its actor remain unchanged; ' +
          'the currently authenticated Admin is recorded separately as the lineage repair operator.'
        : evidence.latestAuditedClaimAttempts !== null
          ? 'This later failed-generation recovery remains bound to the original recovery identity.'
          : ''),
    );
    if (!confirmed) return;
    setRecoveryBusyJobId(evidence.jobId);
    setError('');
    try {
      const path = '/admin/api/publish-job-recoveries';
      const exactEvidence = {
        batchId: evidence.batchId,
        manifestHash: evidence.manifestHash,
        itemId: evidence.itemId,
        jobId: evidence.jobId,
        itemHash: evidence.itemHash,
        snapshotRevision: evidence.snapshotRevision,
      };
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...exactEvidence,
          confirmed: recoveryAction.confirmation,
        }),
      });
      const data = await responseJson<PublishJobRecoveryResponse>(
        response,
        `POST ${path}`,
      );
      if (!response.ok) {
        throw new Error(data.error || 'Failed to recover approved publish job');
      }

      await Promise.all([loadBatches(), loadJobs()]);
    } catch (recoveryError) {
      setError(
        recoveryError instanceof Error
          ? recoveryError.message
          : 'Failed to recover approved publish job',
      );
      await Promise.all([loadBatches(), loadJobs()]);
    } finally {
      setRecoveryBusyJobId('');
    }
  }

  async function attestScheduledSuccess(
    candidate: OperatorSuccessAttestationEvidence,
  ) {
    const confirmed = window.confirm(
      `Yes, this exact attempt succeeded?\n\n${candidate.expectedOutcome.text}\n\n` +
      `Job ${candidate.jobId}\nBatch ${candidate.batchId}\n` +
      `Item ${candidate.itemId}\nManifest ${candidate.manifestHash}\n` +
      `Item hash ${candidate.itemHash}\nSource revision ${candidate.snapshotRevision}\n\n` +
      'This permanently stops dispatch and recovery for this attempt. ' +
      'Public identity will be verified later.',
    );
    if (!confirmed) return;
    const idempotencyKey =
      attestationKeysRef.current[candidate.jobId] ?? crypto.randomUUID();
    attestationKeysRef.current[candidate.jobId] = idempotencyKey;
    setAttestationBusyJobId(candidate.jobId);
    setError('');
    try {
      const path = '/admin/api/local-publish-job-success-attestations';
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          batchId: candidate.batchId,
          manifestHash: candidate.manifestHash,
          itemId: candidate.itemId,
          jobId: candidate.jobId,
          itemHash: candidate.itemHash,
          snapshotRevision: candidate.snapshotRevision,
          requestedPublishAt: candidate.requestedPublishAt,
          confirmed: true,
        }),
      });
      const data = await responseJson<ApiError>(response, `POST ${path}`);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to record success attestation');
      }
      await Promise.all([loadBatches(), loadJobs()]);
    } catch (attestationError) {
      setError(
        attestationError instanceof Error
          ? attestationError.message
          : 'Failed to record success attestation',
      );
      await Promise.all([loadBatches(), loadJobs()]);
    } finally {
      setAttestationBusyJobId('');
    }
  }

  async function markManuallyScheduled(
    candidate: ManualSchedulingAttestationEvidence,
  ) {
    if (!selected) return;
    const scheduledFor = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'America/New_York',
    }).format(new Date(candidate.requestedPublishAt));
    const confirmed = window.confirm(
      `Mark this exact post as manually scheduled — receipt pending?\n\n` +
      `${selected.headline || 'Untitled post'}\nScheduled for ${scheduledFor} ET\n\n` +
      `Post ${selected.id}\nBatch ${candidate.batchId}\nItem ${candidate.itemId}\n` +
      `Manifest ${candidate.manifestHash}\nItem hash ${candidate.itemHash}\n` +
      `Source revision ${candidate.snapshotRevision}\n\n` +
      'This records an immutable operator assertion and immediately closes dispatch for only ' +
      'this frozen packet. It does not mark Notion Published, create a URL or note ID, verify ' +
      'the post, reconcile metrics, or run the worker.',
    );
    if (!confirmed) return;
    const idempotencyKey =
      manualSchedulingKeysRef.current[candidate.itemId] ?? crypto.randomUUID();
    manualSchedulingKeysRef.current[candidate.itemId] = idempotencyKey;
    setManualSchedulingBusyItemId(candidate.itemId);
    setError('');
    try {
      const path = '/admin/api/manual-scheduling-attestations';
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          notionPageId: selected.id,
          batchId: candidate.batchId,
          manifestHash: candidate.manifestHash,
          itemId: candidate.itemId,
          itemHash: candidate.itemHash,
          snapshotRevision: candidate.snapshotRevision,
          requestedPublishAt: candidate.requestedPublishAt,
          confirmed: true,
        }),
      });
      const data = await responseJson<ManualSchedulingAttestationResponse>(
        response,
        `POST ${path}`,
      );
      if (!response.ok) {
        throw new Error(data.error || 'Failed to record manual scheduling');
      }
      delete manualSchedulingKeysRef.current[candidate.itemId];
      await Promise.all([loadBatches(), loadJobs(), loadPosts()]);
    } catch (attestationError) {
      setError(
        attestationError instanceof Error
          ? attestationError.message
          : 'Failed to record manual scheduling',
      );
      await Promise.all([loadBatches(), loadJobs()]);
    } finally {
      setManualSchedulingBusyItemId('');
    }
  }

  async function reconcileAttestedJob(job: LocalPublishJobSummary) {
    const publicPost = receiptInputs[job.id]?.trim();
    if (!publicPost || !receiptConfirmed[job.id] || job.successAttestation?.releaseRequired) {
      return;
    }
    const idempotencyKey = receiptKeysRef.current[job.id] ?? crypto.randomUUID();
    receiptKeysRef.current[job.id] = idempotencyKey;
    setReceiptBusyJobId(job.id);
    setReceiptErrors((current) => ({ ...current, [job.id]: '' }));
    try {
      const evidence = job.successAttestation;
      await revalidatePreparedHandoffForReceipt({
        postId: job.notionPageId,
        jobId: job.id,
        sourceRevision: evidence?.snapshotRevision,
        batchId: evidence?.batchId,
        manifestHash: evidence?.manifestHash,
        itemHash: evidence?.itemHash,
      });
      const path = '/admin/api/local-publish-job-dispositions';
      const response = await adminApiFetch(workspaceId, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          notionPageId: job.notionPageId,
          localJobId: job.id,
          publicPost,
          confirmed: true,
        }),
      });
      const data = await responseJson<ApiError>(response, `POST ${path}`);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to queue public receipt reconciliation');
      }
      delete receiptKeysRef.current[job.id];
      await Promise.all([loadJobs(), loadManualReconciliations()]);
    } catch (submitError) {
      setReceiptErrors((current) => ({
        ...current,
        [job.id]: submitError instanceof Error
          ? submitError.message
          : 'Failed to queue public receipt reconciliation',
      }));
    } finally {
      setReceiptBusyJobId('');
    }
  }

  async function revalidatePreparedHandoffForReceipt(
    override?: {
      postId: string;
      jobId: string;
      sourceRevision?: string;
      batchId?: string;
      manifestHash?: string;
      itemHash?: string;
    },
  ) {
    const prepared = override ? undefined : preparedMobileHandoff?.identity;
    const selectedPostId = override?.postId ?? prepared?.postId ?? selected?.id;
    const expectedJobId = override?.jobId ?? prepared?.localPublishJobId ?? currentJob?.id;
    if (!selectedPostId || !expectedJobId) {
      throw new Error('No exact current Post and local attempt are available for receipt validation.');
    }
    const [postsResponse, jobsResponse, batchesResponse] = await Promise.all([
      adminApiFetch(workspaceId, '/admin/api/ready-posts', { cache: 'no-store' }),
      adminApiFetch(workspaceId, '/admin/api/local-publish-jobs', { cache: 'no-store' }),
      adminApiFetch(workspaceId, '/admin/api/publish-batches', { cache: 'no-store' }),
    ]);
    const [postsData, jobsData, batchesData] = await Promise.all([
      responseJson<ReadyXhsPostsResponse & ApiError>(
        postsResponse,
        'GET /admin/api/ready-posts',
      ),
      responseJson<LocalJobsResponse>(jobsResponse, 'GET /admin/api/local-publish-jobs'),
      responseJson<PublishBatchesResponse>(
        batchesResponse,
        'GET /admin/api/publish-batches',
      ),
    ]);
    if (!postsResponse.ok || !jobsResponse.ok || !batchesResponse.ok) {
      throw new Error('The exact handoff could not be revalidated before receipt submission.');
    }
    const post = postsData.posts.find((candidate) => candidate.id === selectedPostId);
    const parsedJobs = parseAdminLocalJobsResponse(jobsData);
    const job = parsedJobs.jobs.find((candidate) => candidate.id === expectedJobId);
    const eligibleAttempts = parsedJobs.attempts.filter((candidate) =>
      (!prepared || candidate.id === prepared.durableAttemptId)
      && isEligibleAdminRednoteAttempt(candidate, expectedJobId)
      && (!prepared || candidate.payloadDigest === prepared.payloadDigest)
      && (!prepared || candidate.payloadRevision === prepared.payloadRevision));
    const attempt = eligibleAttempts.length === 1 ? eligibleAttempts[0] : undefined;
    const batch = batchesData.batches.find((candidate) =>
      (!prepared || candidate.id === prepared.batchId)
      && (!override?.batchId || candidate.id === override.batchId)
      && candidate.workspaceId === (prepared?.workspaceId ?? workspaceId)
      && (!prepared || candidate.manifestHash === prepared.manifestHash)
      && (!override?.manifestHash || candidate.manifestHash === override.manifestHash)
      && ['approved', 'partially_approved'].includes(candidate.status));
    const item = batch?.items.find((candidate) =>
      (!prepared || candidate.itemHash === prepared.itemHash)
      && (!override?.itemHash || candidate.itemHash === override.itemHash)
      && candidate.localPublishJobId === expectedJobId
      && candidate.notionPageId === selectedPostId
      && !['failed', 'invalidated', 'reconciled'].includes(candidate.state));
    const mediaIdentities = item?.snapshot.media?.map((media) => media.identity)
      ?? (item ? [`${item.snapshot.mediaType}:${item.snapshot.mediaIndex}`] : []);
    const expectedMediaIdentities = prepared?.mediaIdentities ?? mediaIdentities;
    const expectedSourceRevision =
      override?.sourceRevision ?? prepared?.sourceRevision ?? post?.lastEditedTime;
    const eligible = Boolean(
      post
      && job
      && attempt
      && item
      && isManualHandoffEligible({
        destination: item.snapshot.platform,
        studioStatus: post.status,
        publishPacketReady: post.publishPacketReady,
        readinessBlockers: post.automationBlockers,
        workspace: { requestedId: workspaceId, packetId: batch?.workspaceId ?? '' },
        postId: post.id,
        sourceRevision: post.lastEditedTime,
        packet: {
          identity: item.itemHash,
          postId: item.snapshot.notionPageId,
          sourceRevision: item.snapshot.notionLastEditedTime,
          mediaIdentities,
          expectedMediaIdentities,
        },
        attempt: {
          identity: attempt.id,
          sourceLocalPublishJobId: attempt.sourceLocalPublishJobId ?? '',
          payloadDigest: attempt.payloadDigest ?? '',
          payloadRevision: attempt.payloadRevision ?? '',
            eligible: isEligibleAdminRednoteAttempt(attempt, expectedJobId),
        },
          localPublishJobId: expectedJobId,
      }),
    );
    if (
      !eligible
      || !expectedSourceRevision
      || post!.lastEditedTime !== expectedSourceRevision
      || item!.snapshot.notionLastEditedTime !== expectedSourceRevision
    ) {
      throw new Error(
        'The prepared handoff is stale or mismatched. Receipt evidence was not submitted.',
      );
    }
  }

  async function reconcileSelected() {
      if (!selected || !manualConfirmed || !manualPublicPost.trim()) return;
      const idempotencyKey =
        reconciliationKeysRef.current[selected.id] ?? crypto.randomUUID();
      reconciliationKeysRef.current[selected.id] = idempotencyKey;
      setManualSubmitting(true);
      setManualReconciliationError('');
      try {
        await revalidatePreparedHandoffForReceipt();
        const path = '/admin/api/manual-reconciliations';
        const response = await adminApiFetch(workspaceId, path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            notionPageId: selected.id,
            publicPost: manualPublicPost,
            confirmed: true,
          }),
        });
        const data = await responseJson<ManualReconciliationResponse>(
          response,
          `POST ${path}`,
        );
        if (!response.ok) {
          throw new Error(data.error || 'Failed to queue manual reconciliation');
        }
        delete reconciliationKeysRef.current[selected.id];
        setManualReconciliations((current) => [
          data.reconciliation,
          ...current.filter((item) => item.id !== data.reconciliation.id),
        ]);
        setShowManualReconciliation(false);
        setManualConfirmed(false);
      } catch (submitError) {
        setManualReconciliationError(
          submitError instanceof Error
            ? submitError.message
            : 'Failed to queue manual reconciliation',
        );
        void loadManualReconciliations();
      } finally {
        setManualSubmitting(false);
      }
    }

  async function retryManualReconciliation() {
      if (!currentManualReconciliation) return;
      setManualSubmitting(true);
      setManualReconciliationError('');
      try {
        const path =
          `/admin/api/manual-reconciliations/${currentManualReconciliation.id}/retry`;
        const response = await adminApiFetch(workspaceId, path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true }),
        });
        const data = await responseJson<ManualReconciliationResponse>(
          response,
          `POST ${path}`,
        );
        if (!response.ok) {
          throw new Error(data.error || 'Failed to retry manual reconciliation');
        }
        setManualReconciliations((current) => [
          data.reconciliation,
          ...current.filter((item) => item.id !== data.reconciliation.id),
        ]);
      } catch (retryError) {
        setManualReconciliationError(
          retryError instanceof Error
            ? retryError.message
            : 'Failed to retry manual reconciliation',
        );
      } finally {
        setManualSubmitting(false);
    }
  }

  async function copyField(value: string, label: string) {
    const requestId = ++copyRequestRef.current;
    const postId = selected?.id;
    const result = await copyHandoffText(navigator.clipboard, value, label);
    if (
      postId
      &&
      copyRequestRef.current === requestId &&
      selectedPostIdRef.current === postId
    ) {
      setCopyStatus(result);
      setPreparedMobileHandoff((current) => {
        if (!current || current.identity.postId !== postId) return current;
        const updated = {
          ...current,
          identity: {
            ...current.identity,
            clipboard: result.ok ? 'succeeded' as const : 'failed' as const,
          },
        };
        try {
          window.sessionStorage.setItem(
            mobileHandoffStorageKey(updated.identity.workspaceId, updated.identity.postId),
            JSON.stringify(updated.identity),
          );
        } catch {
          // Session storage is an enhancement.
        }
        return updated;
      });
    }
  }

  function copyPreparedField(
    field: 'title' | 'caption' | 'tags' | 'text',
    label: string,
  ) {
    if (
      !preparedActionsAvailable
      || !preparedMobileHandoff
      || !isPreparedHandoffFresh(preparedMobileHandoff.identity.validatedAt)
    ) {
      setMobileHandoffClock(Date.now());
      setCopyStatus({
        ok: false,
        message: 'Prepare and revalidate the exact current packet before copying.',
      });
      return;
    }
    const value = field === 'tags'
      ? formatTags(preparedMobileHandoff.identity.tags)
      : preparedMobileHandoff.identity[field];
    void copyField(value, label);
  }

  function guardPreparedDownload(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (
      preparedActionsAvailable
      && preparedMobileHandoff
      && isPreparedHandoffFresh(preparedMobileHandoff.identity.validatedAt)
    ) {
      return;
    }
    event.preventDefault();
    setMobileHandoffClock(Date.now());
    setMobileHandoffStatus({
      tone: 'error',
      message: 'Prepare and revalidate the exact current packet before downloading assets.',
    });
  }

  function postButton(post: ReadyXhsPost) {
    const job = displayedLocalPublishJob(jobs, post.id);
    const reconciliation = manualReconciliations.find(
      (candidate) => candidate.notionPageId === post.id,
    );
    const truth = publicationOperationalTruth(post, job, reconciliation);
    const isTrialOnly = post.candidateKind === 'mov_compatibility_trial';
    const batchItem = batches.flatMap((batch) => batch.items)
      .find((item) => item.notionPageId === post.id);
    const trustedAssetCount = post.videoUrls.length +
      (post.compatibilityTrialVideoUrls?.length ?? 0) +
      post.imageUrls.length;
    const schedule = getEditorialScheduleDisplay(post.scheduledDate);
    return (
      <button
        className={`${styles.postButton} ${
          selected?.id === post.id ? styles.postButtonSelected : ''
        } ${isTrialOnly ? styles.postButtonTrial : ''}`}
        key={post.id}
        type="button"
        onClick={() => {
          setSelectedId(post.id);
          onNotionPageIdChange?.(post.id);
          setError('');
        }}
      >
        <span className={styles.postTitle}>{post.headline || 'Untitled post'}</span>
        <span className={isTrialOnly ? styles.trialRowLabel : styles.readyRowLabel}>
          {isTrialOnly
            ? 'MOV staging trial only'
            : truth.state !== 'not_published'
              ? truth.label
              : job
                ? dashboardState(job)
                : batchItem?.state === 'approved'
                ? 'Approved'
                : post.publishAt
                  ? post.candidateKind === 'packet_ready'
                    ? 'Needs batch approval'
                    : 'Not ready'
                  : 'Needs publish time'}
        </span>
        <span className={styles.scheduleRow}>
          <span
            className={`${styles.scheduleBadge} ${scheduleStatusClass(schedule.status)}`}
          >
            {schedule.statusLabel}
          </span>
          <span className={styles.scheduleTimes}>
            <span>{schedule.et}</span>
            {schedule.china && <span>{schedule.china}</span>}
          </span>
        </span>
        <span className={styles.postMeta}>
          {job ? `Local job: ${job.status}` : post.status || 'No status'} ·{' '}
          {trustedAssetCount} trusted asset{trustedAssetCount === 1 ? '' : 's'}
        </span>
      </button>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="ready-posts-heading">
      <div className={styles.headingRow}>
        <div>
          <h2 className={styles.heading} id="ready-posts-heading">4. Ready from CREATE</h2>
          <p className={styles.intro}>
            Post or schedule manually first. The worker only stages, verifies, and reconciles
            operator-owned truth; it never gates manual publishing.
          </p>
        </div>
        <button className={styles.refresh} type="button" onClick={() => {
          void loadPosts();
          void loadJobs(true);
          void loadReconciliations();
          void loadManualReconciliations(true);
        }} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh posts'}
        </button>
      </div>

      {warnings.length > 0 && (
        <p className={styles.muted}>Schema notices: {warnings.join(' · ')}</p>
      )}

      {READY_POSTS_PANEL_FEATURES.legacyExecutionAudits &&
        successAttestationCandidates.length > 0 && (
        <section className={styles.successAttestation} aria-labelledby="success-attestation-heading">
          <div>
            <h3 id="success-attestation-heading">Attest scheduled success</h3>
            <p>
              Use only when Creator accepted the exact frozen scheduling attempt but the worker
              receipt is incomplete. This closes dispatch and releases matching staging; it does
              not create a public receipt or mark the post complete.
            </p>
          </div>
          {successAttestationCandidates.map((candidate) => (
            <div key={candidate.jobId} className={styles.successAttestationCandidate}>
              <strong>{candidate.expectedOutcome.text}</strong>
              <small>Job: <code>{candidate.jobId}</code></small>
              <small>Frozen item: <code>{candidate.itemHash}</code></small>
              <button
                className={styles.successAttestationButton}
                type="button"
                disabled={Boolean(attestationBusyJobId)}
                onClick={() => void attestScheduledSuccess(candidate)}
              >
                {attestationBusyJobId === candidate.jobId
                  ? 'Recording attestation…'
                  : 'Attest exact scheduled success'}
              </button>
            </div>
          ))}
        </section>
      )}

      {receiptPendingJobs.length > 0 && (
        <section
          className={styles.receiptReconciliation}
          aria-labelledby="receipt-reconciliation-heading"
        >
          <div>
            <h3 id="receipt-reconciliation-heading">Verify receipt</h3>
            <p>
              These exact attempts were scheduled successfully but still need durable receipt
              identity. Current workers report the note ID and authenticated ownership directly;
              this manual path also accepts a clean public URL when one is available.
            </p>
          </div>
          {receiptPendingJobs.map((job) => {
            const reconciliation = manualReconciliations.find(
              (item) => item.sourceLocalJobId === job.id,
            );
            const releaseRequired = job.successAttestation?.releaseRequired !== false;
            const inputError = manualPublicPostError(receiptInputs[job.id] ?? '');
            const isBusy = receiptBusyJobId === job.id;
            return (
              <div key={job.id} className={styles.receiptCandidate}>
                <strong>
                  {job.successAttestation?.expectedOutcome.text ?? 'Scheduled success attested'}
                </strong>
                <small>Job: <code>{job.id}</code></small>
                <small>Post: <code>{job.notionPageId}</code></small>
                {releaseRequired ? (
                  <p className={styles.receiptBlocker}>
                    Release the matching local staging slot first. This action appears
                    automatically after the capable worker acknowledges the targeted release.
                  </p>
                ) : reconciliation ? (
                  <p className={styles.receiptProgress}>
                    Receipt verification: {reconciliation.status.replace('_', ' ')}.
                    The worker verifies note identity and authenticated ownership before Published.
                  </p>
                ) : (
                  <>
                    <label className={styles.reviewField}>
                      <span>Public RedNote URL or note ID</span>
                      <input
                        autoComplete="off"
                        maxLength={500}
                        placeholder="https://www.rednote.com/explore/…"
                        value={receiptInputs[job.id] ?? ''}
                        onChange={(event) => setReceiptInputs((current) => ({
                          ...current,
                          [job.id]: event.target.value,
                        }))}
                        disabled={isBusy}
                      />
                      <small>
                        Query and fragment data, including xsec_token, is discarded by the server.
                        The note ID is durable; the clean public URL is derived metadata.
                      </small>
                      {inputError && (
                        <small className={styles.inlineError} role="alert">{inputError}</small>
                      )}
                    </label>
                    <label className={styles.confirmation}>
                      <input
                        type="checkbox"
                        checked={receiptConfirmed[job.id] ?? false}
                        onChange={(event) => setReceiptConfirmed((current) => ({
                          ...current,
                          [job.id]: event.target.checked,
                        }))}
                        disabled={isBusy}
                      />
                      <span>
                        I confirm this is the exact existing post and should be verified, not
                        published again.
                      </span>
                    </label>
                    <button
                      className={styles.reconcileSubmit}
                      type="button"
                      onClick={() => void reconcileAttestedJob(job)}
                      disabled={
                        isBusy ||
                        !receiptConfirmed[job.id] ||
                        !receiptInputs[job.id]?.trim() ||
                        Boolean(inputError)
                      }
                    >
                      {isBusy ? 'Queueing verification…' : 'Verify existing post'}
                    </button>
                  </>
                )}
                {receiptErrors[job.id] && (
                  <p className={styles.inlineError} role="alert">{receiptErrors[job.id]}</p>
                )}
              </div>
            );
          })}
        </section>
      )}

      {READY_POSTS_PANEL_FEATURES.boundedBatchApproval && (
      <section className={styles.batchApproval} aria-labelledby="batch-approval-heading">
        <div className={styles.queueHeading}>
          <div>
            <h3 id="batch-approval-heading">Bounded batch approval</h3>
            <p>
              One approval authorizes only the exact frozen items and manifest hash shown here.
              Preparing the selected Post only creates a review candidate; it cannot queue,
              claim, publish, or bypass approval.
            </p>
          </div>
          <div className={styles.actionRow}>
            <button
              className={styles.queueButton}
              type="button"
              disabled={batchBusy || !selected}
              onClick={() => void updateBatch('prepare')}
            >
              {batchBusy ? 'Working…' : 'Prepare selected review candidate'}
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={batchBusy || !selected}
              onClick={() => void updateBatch('create')}
            >
              {batchBusy
                ? 'Working…'
                : pendingBootstrapBatch
                  ? 'Rebuild bootstrap preview'
                  : 'Build bootstrap batch'}
            </button>
          </div>
        </div>
        <p className={styles.muted}>
          Bootstrap is a separate recovery/setup workflow and may supersede an earlier
          bootstrap preview. Normal preparation freezes only the explicitly selected
          canonical Post and never supersedes another candidate.
        </p>
        {pendingBatch ? (
          <>
            <p>
              <strong>
                {pendingBatch.kind === 'on_demand'
                  ? 'Selected Post review candidate'
                  : 'Bootstrap preview'}
              </strong>
            </p>
            <p className={styles.manifestHash}>
              Manifest <code>{pendingBatch.manifestHash}</code>
            </p>
            <p className={styles.muted}>
              {pendingBatch.items.length} approvable · {pendingBatch.blockedCandidates.length} blocked
            </p>
            <ol className={styles.batchItems}>
              {pendingBatch.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.snapshot.title}</strong>
                  <span>
                    {item.dispatchMode === 'post_now'
                      ? `Post now — ${Math.ceil(item.lateBySeconds / 3600)}h late`
                      : `${new Date(item.snapshot.publishAt!).toLocaleString()} · ${shanghaiTime(item.snapshot.publishAt!)}`}
                    {' · '}{item.snapshot.mediaType}
                  </span>
                  <small>{item.snapshot.caption}</small>
                  <small>Tags: {item.snapshot.tags.join(', ') || 'None'}</small>
                  <small>Media: {item.snapshot.mediaUrl}</small>
                  <small>Source revision: {item.snapshot.notionLastEditedTime}</small>
                  <code>{item.itemHash}</code>
                </li>
              ))}
            </ol>
            {pendingBatch.blockedCandidates.length > 0 && (
              <>
                <h4 className={styles.blockedBatchHeading}>
                  Blocked candidates (not authorized by this manifest)
                </h4>
                <ol className={`${styles.batchItems} ${styles.blockedBatchItems}`}>
                  {pendingBatch.blockedCandidates.map((candidate) => (
                    <li key={candidate.notionPageId}>
                      <strong>{candidate.headline}</strong>
                      <span>
                        {candidate.publishAt
                          ? new Date(candidate.publishAt).toLocaleString()
                          : 'Needs publish time'}
                      </span>
                      <small>{candidate.reason}</small>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <button
              className={styles.queueButton}
              type="button"
              disabled={batchBusy || pendingBatch.items.length === 0}
              onClick={() => {
                if (window.confirm(
                  `Approve exactly ${pendingBatch.items.length} frozen item(s)?\n\nManifest ${pendingBatch.manifestHash}`,
                )) {
                  void updateBatch('approve');
                }
              }}
            >
              {pendingBatch.items.length === 0
                ? 'No approvable items'
                : 'Approve this exact manifest'}
            </button>
          </>
        ) : (
          <p className={styles.muted}>
            No review candidate for this selection is awaiting approval. Posts without exact
            times stay visible but cannot be prepared.
          </p>
        )}
        {supersededBatches.map((batch) => (
          <div key={batch.id} className={styles.supersededBatch}>
            <strong>Superseded preview — not approvable</strong>
            <p className={styles.muted}>
              Old manifest <code>{batch.manifestHash}</code> is retained for audit and can
              never be approved.
              {batch.supersededByBatchId && pendingBatch?.id === batch.supersededByBatchId
                ? ' The replacement manifest is shown above.'
                : ' Refresh to load its replacement manifest.'}
            </p>
          </div>
        ))}
        {approvedBatch && (
          <section className={styles.batchLedger} aria-labelledby="batch-ledger-heading">
            <div className={styles.headingRow}>
              <h3 id="batch-ledger-heading">Active scheduled batch</h3>
              <span>
                {approvedBatch.items.length} item{approvedBatch.items.length === 1 ? '' : 's'} ·
                manifest <code>{approvedBatch.manifestHash.slice(0, 12)}…</code>
              </span>
            </div>
            <p className={styles.muted}>
              Approved{' '}
              {approvedBatch.approvedAt
                ? new Date(approvedBatch.approvedAt).toLocaleString()
                : ''}
              {approvedBatch.approvedBy ? ` by ${approvedBatch.approvedBy}` : ''}.
              Items showing ✓ Scheduled or later are safe — never dispatch them again.
            </p>
            <ol className={styles.batchItems}>
              {approvedBatch.items.map((item) => {
                const state = item.state;
                const safeStates: PublishBatchItemState[] = [
                  'scheduled', 'submitted', 'operator_attested',
                  'verification_pending', 'verified', 'reconciled',
                ];
                const isSafe = safeStates.includes(state);
                const isFailed = state === 'failed';
                return (
                  <li key={item.id} className={styles.batchLedgerItem}>
                    <strong>{item.snapshot.title}</strong>
                    <span className={`${styles.batchItemState} ${styles[`batchItemState_${state}`]}`}>
                      {batchItemStateLabel(state)}
                    </span>
                    <span>
                      {item.snapshot.publishAt
                        ? `${new Date(item.snapshot.publishAt).toLocaleString()} · ${shanghaiTime(item.snapshot.publishAt)}`
                        : 'No publish time'}
                      {' · '}{item.snapshot.mediaType}
                    </span>
                    {isSafe && (
                      <small className={styles.batchItemSafe}>
                        This item is already dispatched. Do not re-run it.
                      </small>
                    )}
                    {isFailed && item.recoveryEvidence && (
                      <button
                        className={styles.recoveryButton}
                        type="button"
                        disabled={Boolean(recoveryBusyJobId)}
                        onClick={() => void recoverApprovedJob(
                          item.recoveryEvidence!,
                          item.snapshot.title,
                        )}
                      >
                        {recoveryBusyJobId === item.recoveryEvidence.jobId
                          ? readyPostRecoveryAction(item.recoveryEvidence).busyLabel
                          : readyPostRecoveryAction(item.recoveryEvidence).idleLabel}
                      </button>
                    )}
                    {isFailed && !item.recoveryEvidence && (
                      <small className={styles.batchItemFailedReview}>
                        ⚠ Failed — check job {item.localPublishJobId} for details before retrying.
                      </small>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        {recoverableBatches.map((batch) => (
          <div key={`recovery-${batch.id}`} className={styles.recoveryBatch}>
            <strong>Eligible pre-dispatch recovery</strong>
            <p>
              These exact jobs either remain failed before staging or were already requeued by
              an audited recovery that still lacks its fresh attempt lineage. Recovery preserves
              the approved job and creates one fresh approved worker attempt generation with no
              second approval or replacement local job. The fixed hydration failure is eligible
              only as a proven, immediately later terminal claim generation. A Creator login
              failure is eligible only for its canonical pre-staging code and message. A
              browser-closed media-loading failure is eligible only for its exact canonical
              pre-Publish code and message. Any currently authenticated authorized Admin may
              complete a missing-lineage repair; the original
              audit actor is preserved and the repair operator is recorded separately. A later
              failed-generation recovery remains bound to the original recovery identity.
            </p>
            <small>
              Original approval: {batch.approvedAt
                ? new Date(batch.approvedAt).toLocaleString()
                : 'Missing'} by {batch.approvedBy || 'unknown'}
            </small>
            <ol className={styles.batchItems}>
              {batch.items.flatMap((item) => item.recoveryEvidence ? [(
                <li key={item.id}>
                  <strong>{item.snapshot.title}</strong>
                  <small>Job: <code>{item.recoveryEvidence.jobId}</code></small>
                  <small>Batch item: <code>{item.id}</code></small>
                  <small>Manifest: <code>{batch.manifestHash}</code></small>
                  <small>Item hash: <code>{item.itemHash}</code></small>
                  <small>
                    Source revision: <code>{item.snapshot.notionLastEditedTime}</code>
                  </small>
                  <small>
                    Original publish time: <code>{item.snapshot.publishAt}</code>
                  </small>
                  <small>
                    Recovery reason: {
                      readyPostRecoveryAction(item.recoveryEvidence).reason
                    }
                  </small>
                  <small>
                    Terminal failure generation: <code>
                      {item.recoveryEvidence.claimAttempts}
                    </code>
                    {item.recoveryEvidence.latestAuditedClaimAttempts !== undefined
                      ? <> (latest audited: <code>
                          {item.recoveryEvidence.latestAuditedClaimAttempts}
                        </code>)</>
                      : ' (not previously audited)'}
                  </small>
                  <button
                    className={styles.recoveryButton}
                    type="button"
                    disabled={Boolean(recoveryBusyJobId)}
                    onClick={() => void recoverApprovedJob(
                      item.recoveryEvidence!,
                      item.snapshot.title,
                      item.state === 'queued',
                    )}
                  >
                    {recoveryBusyJobId === item.recoveryEvidence.jobId
                      ? readyPostRecoveryAction(
                          item.recoveryEvidence,
                          item.state === 'queued',
                        ).busyLabel
                      : readyPostRecoveryAction(
                          item.recoveryEvidence,
                          item.state === 'queued',
                        ).idleLabel}
                  </button>
                </li>
              )] : [])}
            </ol>
          </div>
        ))}
      </section>
      )}

      {requestedPostMissing && (
        <p className={styles.handoffMissingNotice} role="status">
          Requested XHS handoff record <code>{initialNotionPageId}</code> no longer exists.
          Showing the current available selection instead; no action was started.
        </p>
      )}

      {loading && posts.length === 0 ? (
        <p className={styles.empty}>Loading publish-ready posts…</p>
      ) : posts.length === 0 ? (
        <p className={styles.empty}>
          No unpublished RedNote packets are ready. Completed local jobs remain in the database
          audit trail.
        </p>
      ) : (
        <div className={styles.workspace}>
          <div className={styles.postList} aria-label="Ready and MOV trial candidates">
            {packetReadyPosts.length > 0 && (
              <section className={styles.candidateGroup} aria-labelledby="packet-ready-group">
                <h3 id="packet-ready-group">Packet-ready posts</h3>
                {packetReadyPosts.map(postButton)}
              </section>
            )}
            {movTrialPosts.length > 0 && (
              <section className={styles.candidateGroup} aria-labelledby="mov-trial-group">
                <h3 id="mov-trial-group">MOV staging trials</h3>
                <p>Unverified, media-blocked records for Creator staging only.</p>
                {movTrialPosts.map(postButton)}
              </section>
            )}
            {activeUnpublishedPosts.length > 0 && (
              <section className={styles.candidateGroup} aria-labelledby="active-unpublished-group">
                <h3 id="active-unpublished-group">Active unpublished</h3>
                <p>Visible for repair; incomplete records cannot enter a batch.</p>
                {activeUnpublishedPosts.map(postButton)}
              </section>
            )}
            {publishedPosts.length > 0 && (
              <section className={styles.candidateGroup} aria-labelledby="published-group">
                <h3 id="published-group">Published</h3>
                <p>Canonical or verified published records; never dispatch these again.</p>
                {publishedPosts.map(postButton)}
              </section>
            )}
          </div>

          {selected && (
            <article className={styles.detail}>
              <div className={styles.statusRow}>
                <h3 className={styles.detailTitle}>{selected.headline || 'Untitled post'}</h3>
                <span className={
                  selected.candidateKind === 'mov_compatibility_trial'
                    ? styles.trialBadge
                    : styles.badge
                }>
                  {selected.candidateKind === 'mov_compatibility_trial'
                    ? 'MOV trial only'
                    : 'Packet ready'}
                </span>
              </div>
              <p className={styles.muted}>Notion status: {selected.status || 'Not set'}</p>
              {currentTruth && (
                <p className={styles.muted}>Operational truth: {currentTruth.label}</p>
              )}
              {selectedSchedule && (
                <div className={styles.scheduleSummary}>
                  <div className={styles.scheduleSummaryHeading}>
                    <strong>Editorial schedule</strong>
                    <span
                      className={`${styles.scheduleBadge} ${
                        scheduleStatusClass(selectedSchedule.status)
                      }`}
                    >
                      {selectedSchedule.statusLabel}
                    </span>
                  </div>
                  <p>
                    {selectedSchedule.et}
                    {selectedSchedule.china && ` · ${selectedSchedule.china}`}
                  </p>
                  <p className={styles.scheduleAdvisory}>
                    Advisory display only. Operator review and approval remain authoritative.
                  </p>
                </div>
              )}

              {selectedMedia?.type === 'video' && (
                <video
                  className={styles.video}
                  controls
                  poster={mediaPreview.thumbnailUrl}
                  preload="metadata"
                  src={selectedMedia.url}
                >
                  Your browser cannot preview this video.
                </video>
              )}
              {selectedMedia?.type === 'image' && (
                <div className={styles.imagePreview}>
                  <Image
                    alt=""
                    fill
                    sizes="(max-width: 640px) 100vw, 520px"
                    src={selectedMedia.url}
                  />
                </div>
              )}

              {mediaPreview.rejectedUrls.length > 0 && (
                <div className={styles.manualWarnings} role="alert">
                  <strong>Untrusted media preview hidden</strong>
                  <p>
                    Replace placeholder or non-canonical media URLs in Notion before publishing.
                  </p>
                </div>
              )}

              {selected.manualWarnings.length > 0 && (
                <div className={styles.manualWarnings} role="note">
                  <strong>Manual handoff warnings</strong>
                  <ul className={styles.blockers}>
                    {selected.manualWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              )}

              {(selected.compatibilityTrialVideoUrls?.length ?? 0) > 0 && (
                <div className={styles.compatibilityTrialWarning} role="note">
                  <strong>Unverified MOV compatibility trial available</strong>
                  <p>
                    This trusted canonical MEDIA registration is still media-blocked. It is not
                    certified or publish-ready. Select the MOV only to test Creator staging.
                  </p>
                </div>
              )}

              <details className={styles.automation}>
                <summary>Explicit automation · legacy Mac worker</summary>
                {selected.automationBlockers.length > 0 && (
                  <div className={styles.automationBlockers} role="note">
                    <strong>Automation blockers</strong>
                    <ul className={styles.blockers}>
                      {selected.automationBlockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <section className={styles.localQueue} aria-labelledby="local-queue-heading">
                <div className={styles.queueHeading}>
                  <div>
                    <h4 id="local-queue-heading">Local RedNote browser queue</h4>
                    <p>
                      Finalize the copy here. Media is selected only from the canonical server
                      packet and cannot be replaced by a client-provided URL.
                    </p>
                  </div>
                  <span className={styles.primaryPath}>Explicit automation</span>
                </div>

                {currentJobStatus && (
                  <div
                    className={`${styles.jobStatus} ${
                      styles[`jobStatus${currentJobStatus.tone}`]
                    }`}
                    role="status"
                  >
                    <strong>{currentJobStatus.title}</strong>
                    <p>{currentJobStatus.detail}</p>
                    {(currentJob?.status === 'verified' ||
                      currentJob?.status === 'reconciled') &&
                      currentJob.shareUrl && (
                      <a href={currentJob.shareUrl} {...SAFE_EXTERNAL_LINK_PROPS}>
                        Open verified RedNote post
                      </a>
                    )}
                  </div>
                )}

                {READY_POSTS_PANEL_FEATURES.legacyExecutionAudits &&
                  manualSchedulingCandidate && (
                  <div className={styles.manualReconciliation}>
                    <div className={styles.manualReconciliationHeading}>
                      <div>
                        <strong>Already scheduled manually?</strong>
                        <p>
                          First set this exact time in RedNote Creator, then copy the same instant
                          into Notion ScheduledDate. Only then close dispatch for this frozen
                          packet. Notion stays unchanged until the note ID and authenticated
                          ownership are independently verified.
                        </p>
                        <small>
                          Packet <code>{manualSchedulingCandidate.itemHash}</code>
                        </small>
                      </div>
                      <button
                        className={styles.successAttestationButton}
                        type="button"
                        disabled={Boolean(manualSchedulingBusyItemId)}
                        onClick={() => void markManuallyScheduled(manualSchedulingCandidate)}
                      >
                        {manualSchedulingBusyItemId === manualSchedulingCandidate.itemId
                          ? 'Recording scheduling…'
                          : 'Mark scheduled — receipt pending'}
                      </button>
                    </div>
                  </div>
                )}

                <div className={styles.reviewFields}>
                  <label className={styles.reviewField}>
                    <span>Final title</span>
                    <input
                      maxLength={100}
                      value={finalTitle}
                      onChange={(event) => setFinalTitle(event.target.value)}
                      disabled={hasActiveJob || hasActiveManualReconciliation || selectedIsPublished}
                    />
                  </label>
                  <label className={styles.reviewField}>
                    <span>Reviewed caption</span>
                    <textarea
                      maxLength={5000}
                      rows={7}
                      value={finalCaption}
                      onChange={(event) => setFinalCaption(event.target.value)}
                      disabled={hasActiveJob || hasActiveManualReconciliation || selectedIsPublished}
                    />
                    <small>
                      Prefilled from Caption. Trailing hashtags are removed only when Final Tags
                      is absent.
                    </small>
                  </label>
                  <label className={styles.reviewField}>
                    <span>Final tags</span>
                    <input
                      maxLength={2000}
                      value={finalTags}
                      onChange={(event) => setFinalTags(event.target.value)}
                      placeholder="Comma-separated tags"
                      disabled={hasActiveJob || hasActiveManualReconciliation || selectedIsPublished}
                    />
                    <small>
                      {selected.tagsSource === 'legacy-caption'
                        ? 'Legacy fallback from trailing Caption hashtags. '
                        : 'Prefilled from Final Tags. '}
                      Up to 20 tags; a leading # is removed before queueing.
                    </small>
                  </label>
                  {timing && (
                    <div className={styles.publishTiming} role="note">
                      <span>Publish timing</span>
                      <strong>{timing.label}</strong>
                      <small>{timing.detail}</small>
                    </div>
                  )}
                  <label className={styles.reviewField}>
                    <span>Trusted media</span>
                    <select
                      value={selectedMedia
                        ? `${selectedMedia.compatibilityTrial ?? selectedMedia.type}:${selectedMedia.index}`
                        : ''}
                      onChange={(event) => setMediaKey(event.target.value)}
                      disabled={hasActiveJob || hasActiveManualReconciliation || selectedIsPublished}
                    >
                      {mediaChoices.map((choice) => (
                        <option
                          key={`${choice.compatibilityTrial ?? choice.type}:${choice.index}`}
                          value={`${choice.compatibilityTrial ?? choice.type}:${choice.index}`}
                        >
                          {choice.compatibilityTrial
                            ? 'MOV compatibility trial'
                            : choice.type === 'video'
                              ? 'Video'
                              : 'Image'}{' '}
                          {choice.index + 1}
                        </option>
                      ))}
                    </select>
                    <small className={styles.assetUrl}>{selectedMedia?.url}</small>
                  </label>
                </div>

                <button
                  className={styles.queueButton}
                  type="button"
                  onClick={queueSelected}
                  disabled={
                    queueing ||
                    selectedIsPublished ||
                    hasActiveJob ||
                    hasActiveManualReconciliation ||
                    (isMovCompatibilityTrial
                      ? !movTrialIsEligible
                      : selected.candidateKind !== 'packet_ready' ||
                        selected.automationBlockers.length > 0 ||
                        !selected.publishAt) ||
                    !selectedMedia ||
                    !finalTitle.trim() ||
                    !finalCaption.trim()
                  }
                >
                  {queueing
                    ? 'Queueing…'
                    : isMovCompatibilityTrial
                      ? 'Queue unverified MOV staging trial'
                      : 'Queue for local RedNote browser'}
                </button>
                {isMovCompatibilityTrial && (
                  <p className={styles.compatibilityTrialNotice}>
                    Staging trial only. Queueing does not certify MOV, clear media blockers, or
                    authorize publishing. Publish still requires the exact worker-displayed
                    <code> PUBLISH &lt;jobId&gt;</code> approval.
                  </p>
                )}
                <p className={styles.queueNotice}>
                  Bounded-batch jobs carry their approved manifest and may be scheduled
                  sequentially without per-job approval. Legacy and MOV trial jobs still require
                  exact per-job approval.
                </p>
                </section>
              </details>

              <section className={styles.handoff} aria-labelledby="manual-handoff-heading">
                <div className={styles.handoffHeading}>
                  <div>
                    <h4 id="manual-handoff-heading">Manual RedNote handoff</h4>
                    <p>Default path · operator-controlled Creator publishing and durable receipt.</p>
                  </div>
                  <span className={styles.primaryPath}>Default</span>
                </div>
                <p>
                  Nothing is sent to RedNote until you act in Creator. Warnings stay visible but do
                  not prevent recording what the operator actually did.
                </p>

                <div className={styles.mobileBootstrap}>
                  <div>
                    <span className={styles.fieldLabel}>Frozen handoff identity</span>
                    <strong>{handoffSnapshot?.title ?? selected.headline}</strong>
                    <p>
                      Post {selected.id}
                      {handoffSnapshot
                        ? ` · source revision ${handoffSnapshot.notionLastEditedTime}`
                        : ''}
                      {currentJob ? ` · attempt ${currentJob.id}` : ' · no active attempt'}
                      {handoffAttempt
                        ? ` · durable attempt ${handoffAttempt.durableAttempt.id}`
                        : ''}
                      {handoffAttempt ? ` · manifest ${handoffAttempt.manifestHash}` : ''}
                    </p>
                  </div>
                  <button
                    className={styles.sendButton}
                    type="button"
                    onClick={prepareMobileHandoff}
                    disabled={
                      mobileHandoffBusy
                      || !handoffAttempt
                      || !handoffSnapshot
                      || handoffMedia.length === 0
                      || !manualHandoffEligible
                      || selectedIsPublished
                      || hasLiveManualOwnership
                    }
                  >
                    {mobileHandoffBusy ? 'Preparing exact packet…' : 'Prepare exact packet'}
                  </button>
                  {preparedActionsAvailable
                    && preparedMobileHandoff?.identity.shareable && (
                    <button
                      className={styles.sendButton}
                      type="button"
                      onClick={sharePreparedMobileHandoff}
                    >
                      Share prepared packet
                    </button>
                  )}
                  <p>
                    Preparation revalidates and fetches every numbered asset but does not copy,
                    share, or open Creator. Clipboard, share-sheet, and Creator actions are
                    separate explicit gestures available for two minutes. None marks the Post
                    Published.
                  </p>
                  {mobileHandoffStatus && (
                    <p
                      className={
                        mobileHandoffStatus.tone === 'success'
                          ? styles.bootstrapSuccess
                          : mobileHandoffStatus.tone === 'warning'
                            ? styles.bootstrapWarning
                            : styles.bootstrapError
                      }
                      role="status"
                      aria-live="polite"
                    >
                      {mobileHandoffStatus.message}
                    </p>
                  )}
                  {mobileShareStatus && (
                    <p
                      className={
                        mobileShareStatus.tone === 'success'
                          ? styles.bootstrapSuccess
                          : mobileShareStatus.tone === 'warning'
                            ? styles.bootstrapWarning
                            : styles.bootstrapError
                      }
                      role="status"
                      aria-live="polite"
                    >
                      {mobileShareStatus.message}
                    </p>
                  )}
                </div>

                {currentManualHandling ? (
                  <div
                    className={`${styles.jobStatus} ${
                      currentManualHandling.receiptStatus === 'reconciled'
                        ? styles.jobStatussuccess
                        : styles.jobStatuswarning
                    }`}
                    role="status"
                  >
                    <strong>
                      {currentManualHandling.receiptStatus === 'reconciled'
                        ? 'Published · verified manual receipt'
                        : 'Approved · operator handled · receipt pending'}
                    </strong>
                    <p>
                      {currentManualHandling.receiptStatus === 'reconciled'
                        ? `Reconciled note ${currentManualHandling.noteId}.`
                        : `${currentManualHandling.mode === 'scheduled' ? 'Scheduled' : 'Published'} was recorded as durable operator truth. Automatic dispatch is closed.`}
                    </p>
                    {currentManualHandling.shareUrl && (
                      <a
                        href={currentManualHandling.shareUrl}
                        {...SAFE_EXTERNAL_LINK_PROPS}
                      >
                        Open reconciled RedNote post
                      </a>
                    )}
                  </div>
                ) : !selectedIsPublished && (
                  <div className={styles.manualHandlingAction}>
                    <label className={styles.reviewField}>
                      <span>What did you do in Creator?</span>
                      <select
                        value={manualHandlingMode}
                        onChange={(event) =>
                          setManualHandlingMode(event.target.value as ManualHandlingMode)}
                        disabled={manualHandlingSubmitting || hasLiveManualOwnership}
                      >
                        <option value="scheduled">Scheduled in Creator</option>
                        <option value="published">Published in Creator</option>
                      </select>
                    </label>
                    <button
                      className={styles.reconcileSubmit}
                      type="button"
                      onClick={markSelectedHandledManually}
                      disabled={
                        manualHandlingSubmitting
                        || hasLiveManualOwnership
                        || !manualHandoffEligible
                      }
                    >
                      {manualHandlingSubmitting ? 'Recording…' : 'Mark handled manually'}
                    </button>
                  </div>
                )}

                {currentManualStatus && (
                  <div
                    className={`${styles.jobStatus} ${
                      styles[`jobStatus${currentManualStatus.tone}`]
                    }`}
                    role="status"
                  >
                    <strong>{currentManualStatus.title}</strong>
                    <p>{currentManualStatus.detail}</p>
                    {currentManualReconciliation?.status === 'failed' && (
                      <button
                        className={styles.retryButton}
                        type="button"
                        onClick={retryManualReconciliation}
                        disabled={manualSubmitting || hasActiveJob}
                      >
                        {manualSubmitting ? 'Retrying…' : 'Retry verification'}
                      </button>
                    )}
                    {currentManualReconciliation?.status === 'reconciled' && (
                      <a
                        href={currentManualReconciliation.shareUrl}
                        {...SAFE_EXTERNAL_LINK_PROPS}
                      >
                        Open reconciled RedNote post
                      </a>
                    )}
                  </div>
                )}

                {!currentManualReconciliation &&
                  !selectedIsPublished &&
                  canStartManualReconciliation && (
                  <div className={styles.manualReconciliation}>
                    <div className={styles.manualReconciliationHeading}>
                      <div>
                        <strong>Verify public identity</strong>
                        <p>
                          Paste the live URL or note ID after the post is public. Verification never
                          clicks Publish and Notion stays Approved until it succeeds.
                        </p>
                      </div>
                      <button
                        className={styles.reconcileButton}
                        type="button"
                        onClick={() => setShowManualReconciliation((current) => !current)}
                        aria-expanded={showManualReconciliation}
                      >
                        {showManualReconciliation ? 'Cancel' : 'Paste URL / note ID'}
                      </button>
                    </div>
                    {showManualReconciliation && (
                      <div className={styles.manualReconciliationForm}>
                        <label className={styles.reviewField}>
                          <span>Public RedNote URL or note ID</span>
                          <input
                            autoComplete="off"
                            maxLength={500}
                            placeholder="https://www.rednote.com/explore/…"
                            value={manualPublicPost}
                            onChange={(event) => setManualPublicPost(event.target.value)}
                            disabled={manualSubmitting}
                          />
                          <small>
                            Query and fragment data is discarded. The exact public identity is
                            verified before any Notion backfill.
                          </small>
                          {manualUrlError && (
                            <small className={styles.inlineError} role="alert">
                              {manualUrlError}
                            </small>
                          )}
                        </label>
                        <label className={styles.confirmation}>
                          <input
                            type="checkbox"
                            checked={manualConfirmed}
                            onChange={(event) => setManualConfirmed(event.target.checked)}
                            disabled={manualSubmitting}
                          />
                          <span>
                            I confirm this post is already public and must be verified, not
                            published again.
                          </span>
                        </label>
                        <button
                          className={styles.reconcileSubmit}
                          type="button"
                          onClick={reconcileSelected}
                          disabled={
                            manualSubmitting
                            || !manualConfirmed
                            || !manualPublicPost.trim()
                            || Boolean(manualUrlError)
                          }
                        >
                          {manualSubmitting
                            ? 'Queueing verification…'
                            : 'Queue public verification'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {manualReconciliationError && (
                  <p className={styles.inlineError} role="alert">
                    {manualReconciliationError}
                  </p>
                )}

                <div className={styles.orderedAssets}>
                  <div className={styles.orderedAssetsHeading}>
                    <div>
                      <strong>Ordered packet media</strong>
                      <p>
                        Save every asset in numbered order if the share sheet cannot carry them all.
                      </p>
                    </div>
                    <span>{handoffMedia.length} asset{handoffMedia.length === 1 ? '' : 's'}</span>
                  </div>
                  <ol>
                    {handoffMedia.map((media, index) => {
                      const preparedUrl = preparedMobileHandoff?.downloadUrls[index];
                      const preparedFile = preparedMobileHandoff?.files[index];
                      return (
                        <li key={media.identity}>
                          <span>
                            {String(index + 1).padStart(2, '0')} · {media.type}
                          </span>
                          {preparedActionsAvailable && preparedUrl && preparedFile ? (
                            <a
                              className={styles.secondaryButton}
                              href={preparedUrl}
                              download={preparedFile.name}
                              onClick={guardPreparedDownload}
                            >
                              Save asset {index + 1}
                            </a>
                          ) : (
                            <span className={styles.missingAsset}>
                              Prepare exact packet to save
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>

                <div className={styles.assetAction}>
                  <div>
                    <strong>Prepare the canonical video</strong>
                    <p>Download the MP4, then select that file in Creator.</p>
                  </div>
                  {preparedActionsAvailable
                    && handoffVideoIndex >= 0
                    && preparedMobileHandoff?.downloadUrls[handoffVideoIndex]
                    && preparedMobileHandoff.files[handoffVideoIndex] ? (
                    <a
                      className={styles.secondaryButton}
                      href={preparedMobileHandoff.downloadUrls[handoffVideoIndex]}
                      download={preparedMobileHandoff.files[handoffVideoIndex].name}
                      onClick={guardPreparedDownload}
                    >
                      Download video
                    </a>
                  ) : (
                    <span className={styles.missingAsset}>
                      {handoffVideoIndex >= 0
                        ? 'Prepare exact packet to download the canonical video'
                        : 'Canonical MEDIA video unavailable'}
                    </span>
                  )}
                </div>

                <div className={styles.copyFields}>
                  {showHandoffTitleCopy && (
                    <div className={styles.copyField}>
                      <div>
                        <span className={styles.fieldLabel}>Title</span>
                        <p>{handoffTitle}</p>
                      </div>
                      <button
                        className={styles.copyButton}
                        type="button"
                        onClick={() => copyPreparedField('title', 'Title')}
                        disabled={!preparedActionsAvailable}
                      >
                        Copy title
                      </button>
                    </div>
                  )}
                  <div className={styles.copyField}>
                    <div>
                      <span className={styles.fieldLabel}>Caption</span>
                      <p className={styles.caption}>
                        {handoffCaption || 'No RedNote caption provided.'}
                      </p>
                    </div>
                    <button
                      className={styles.copyButton}
                      type="button"
                      onClick={() => copyPreparedField('caption', 'Caption')}
                      disabled={!preparedActionsAvailable}
                    >
                      Copy caption
                    </button>
                  </div>
                  {preparedMissingTags.length > 0 && (
                    <div className={styles.copyField}>
                      <div>
                        <span className={styles.fieldLabel}>Tags not already in the caption</span>
                        <p>{formatTags(preparedMissingTags)}</p>
                      </div>
                      <button
                        className={styles.copyButton}
                        type="button"
                        onClick={() => copyPreparedField('tags', 'Tags')}
                        disabled={!preparedActionsAvailable}
                      >
                        Copy tags
                      </button>
                    </div>
                  )}
                  <div className={styles.copyField}>
                    <div>
                      <span className={styles.fieldLabel}>Caption plus final tags</span>
                      <p>Copy the exact approved caption and final tags together.</p>
                    </div>
                    <button
                      className={styles.copyButton}
                      type="button"
                      onClick={() => copyPreparedField('text', 'Caption and tags')}
                      disabled={!preparedActionsAvailable}
                    >
                      Copy caption + tags
                    </button>
                  </div>
                </div>

                {copyStatus && (
                  <p
                    className={copyStatus.ok ? styles.copySuccess : styles.copyError}
                    role="status"
                    aria-live="polite"
                  >
                    {copyStatus.message}
                  </p>
                )}

                <div className={styles.handoffActions}>
                  {preparedActionsAvailable ? (
                    <a
                      className={styles.creatorButton}
                      href={REDNOTE_CREATOR_PUBLISH_URL}
                      onClick={recordCreatorOpening}
                      {...SAFE_EXTERNAL_LINK_PROPS}
                    >
                      Open RedNote Creator
                    </a>
                  ) : (
                    <span className={styles.missingAsset}>
                      Prepare the exact current packet before opening RedNote Creator
                    </span>
                  )}
                  <a
                    className={styles.linkButton}
                    href={selected.pageUrl}
                    {...SAFE_EXTERNAL_LINK_PROPS}
                  >
                    Open packet in Notion
                  </a>
                </div>
                {creatorOpenStatus && (
                  <p
                    className={styles.bootstrapWarning}
                    role="status"
                    aria-live="polite"
                  >
                    {creatorOpenStatus.message}
                  </p>
                )}
                <p className={styles.backfillNotice}>
                  Leave the source unpublished until the note ID and authenticated account ownership
                  are verified. Successful verification moves the canonical row to Published without
                  rewriting packet, copy, media, or needs flags. Public indexing is a later,
                  non-blocking audit attribute.
                </p>
              </section>

              <details className={styles.experimental}>
                <summary>Legacy cloud cookie publisher — retired</summary>
                <p>
                  Cloud publishing is disabled. Use the local browser queue or the manual handoff
                  controls above.
                </p>
                <button className={styles.publishButton} type="button" disabled>
                  Cloud API publishing disabled
                </button>
              </details>
            </article>
          )}
        </div>
      )}

      <section className={styles.reconciliationAudit} aria-labelledby="reconciliation-audit-heading">
        <div className={styles.auditHeading}>
          <div>
            <h3 id="reconciliation-audit-heading">Externally published posts</h3>
            <p>
              Read-only receipts from the verified Mac worker. These records never add a
              canonical MEDIA URL to Notion.
            </p>
          </div>
          <span>{reconciliations.length} receipt{reconciliations.length === 1 ? '' : 's'}</span>
        </div>
        {reconciliationError ? (
          <p className={styles.auditWarning} role="status">
            External reconciliation receipts are unavailable: {reconciliationError}. The local
            publish queue remains available.
          </p>
        ) : reconciliations.length === 0 ? (
          <p className={styles.auditEmpty}>No external RedNote posts have been reconciled.</p>
        ) : (
          <div className={styles.auditList}>
            {reconciliations.map((record) => (
              <article className={styles.auditRow} key={record.id}>
                <div className={styles.auditIdentity}>
                  <a href={record.shareUrl} {...SAFE_EXTERNAL_LINK_PROPS}>
                    {record.title}
                  </a>
                  <span>
                    {record.mediaType === 'video' ? 'Video' : 'Image'} · note {record.noteId}
                  </span>
                </div>
                <div className={styles.auditResult}>
                  <strong className={styles[`auditStatus${record.status}`]}>
                    {record.status}
                  </strong>
                  <span>
                    {record.status === 'succeeded'
                      ? record.outcome?.replaceAll('_', ' ')
                      : record.status === 'failed'
                        ? `${record.errorCode || 'FAILED'} — retry the same verified snapshot`
                        : 'Notion reconciliation in progress'}
                  </span>
                  <time dateTime={record.updatedAt}>
                    {new Date(record.updatedAt).toLocaleString()}
                  </time>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
