'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExternalReconciliationSummary,
  LocalPublishJobSummary,
  LocalPublishMediaType,
  ManualReconciliationSummary,
  PublishBatch,
  RednotePublishJobRecovery,
  RednotePublishJobRecoveryEvidence,
} from '@/types/local-publish-job';
import type { ReadyXhsPost, ReadyXhsPostsResponse } from '@/types/ready-post';
import styles from './ReadyPostsPanel.module.css';
import { responseJson } from '@/lib/response-json';
import {
  copyHandoffText,
  formatTags,
  getCanonicalVideoUrl,
  getMissingTags,
  getVideoDownloadName,
  REDNOTE_CREATOR_PUBLISH_URL,
  SAFE_EXTERNAL_LINK_PROPS,
  shouldOfferTitleCopy,
} from '@/lib/manual-rednote-handoff';
import { isMovCompatibilityTrialEligible } from '@/lib/mov-compatibility-trial';
import {
  displayedLocalPublishJob,
  isActiveLocalPublishJob,
} from '@/lib/local-publish-job-display';

interface ApiError {
  error?: string;
  code?: string;
}

interface PublishBatchesResponse extends ApiError {
  batches: PublishBatch[];
  batch?: PublishBatch | null;
}

interface LocalJobsResponse extends ApiError {
  jobs: LocalPublishJobSummary[];
}

interface PublishJobRecoveryResponse extends ApiError {
  recovery: RednotePublishJobRecovery;
}

function manualPublicPostError(value: string) {
  const candidate = value.trim();
  if (!candidate) return '';
  if (/[?#]/.test(candidate) || /xsec_token|creator|manager/i.test(candidate)) {
    return 'Remove all query, xsec_token, creator-manager, and fragment parameters. Use https://www.rednote.com/explore/NOTE_ID.';
  }
  if (
    candidate.startsWith('http') &&
    !/^https:\/\/www\.rednote\.com\/explore\/[A-Za-z0-9_-]+$/.test(candidate)
  ) {
    return 'Use the clean public URL format https://www.rednote.com/explore/NOTE_ID.';
  }
  return '';
}

interface LocalJobResponse extends ApiError {
  job: LocalPublishJobSummary;
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

type MediaChoice = {
  type: LocalPublishMediaType;
  index: number;
  url: string;
  compatibilityTrial?: 'unverified_mov';
};

function tagsFromInput(value: string) {
  return value
    .split(/[,\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean);
}

function publishTiming(post: ReadyXhsPost) {
  if (post.publishBlockers.includes(
    'ScheduledDate must include a valid publish time and timezone',
  )) {
    return {
      label: 'Invalid ScheduledDate',
      detail: 'Set an exact publish time with timezone in Notion before queueing.',
    };
  }
  if (!post.publishAt) {
    return {
      label: 'Needs publish time',
      detail: 'Set an exact ScheduledDate instant with timezone before batch approval.',
    };
  }
  return {
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(new Date(post.publishAt)),
    detail: post.publishAt,
  };
}

function jobStatusCopy(job: LocalPublishJobSummary | undefined) {
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
    return {
      tone: movTrial ? 'warning' : 'pending',
      title: movTrial
        ? 'Unverified MOV staging trial claimed'
        : 'Claimed by the Mac worker',
      detail: movTrial
        ? 'Creator staging or human review is in progress. Publishing still requires the exact job approval.'
        : 'Browser staging or human review is in progress. This post is not published yet.',
    };
  }
  if (job.status === 'staged') {
    return {
      tone: 'pending',
      title: 'Staged in RedNote Creator',
      detail: 'The packet is staged but has not been submitted. A definitive staging error may still fail safely.',
    };
  }
  if (job.status === 'submitted' || job.status === 'scheduled') {
    return {
      tone: 'pending',
      title: job.status === 'scheduled'
        ? 'Scheduled in RedNote Creator'
        : 'Submitted to RedNote',
      detail: job.nextVerificationAt
        ? `Stable identifiers are saved. Public verification is due ${new Intl.DateTimeFormat(
            undefined,
            { dateStyle: 'medium', timeStyle: 'short' },
          ).format(new Date(job.nextVerificationAt))}. Do not publish again.`
        : 'Stable identifiers are saved. Public verification is pending; do not publish again.',
    };
  }
  if (job.status === 'verification_pending') {
    return {
      tone: 'warning',
      title: `Public verification pending${job.errorCode ? ` (${job.errorCode})` : ''}`,
      detail: job.nextVerificationAt
        ? `${job.errorMessage || 'RedNote is still processing or indexing the post.'} Retry is due ${
            new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(job.nextVerificationAt))
          }. Do not publish again.`
        : `${job.errorMessage || 'RedNote is still processing or indexing the post.'} Do not publish again.`,
    };
  }
  if (job.status === 'verified') {
    return {
      tone: 'warning',
      title: 'Public post verified; Notion reconciliation pending',
      detail:
        'The query-free public post is visible. Do not publish again; retry the same verified report to finish Notion backfill.',
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
    title: 'Verified and reconciled',
    detail: 'The exact public RedNote post was verified before Notion was marked Published.',
  };
}

function dashboardState(job: LocalPublishJobSummary | undefined) {
  if (!job) return undefined;
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'claimed' || job.status === 'staged') return 'Scheduling';
  if (job.status === 'submitted' || job.status === 'scheduled') return 'Scheduled/Submitted';
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
        'The worker is checking the exact note ID, public URL, title, caption, and media type. Do not publish again.',
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
    title: 'Existing post verified and reconciled',
    detail:
      'The exact public RedNote post was verified and the canonical Notion row was marked Published.',
  };
}

export default function ReadyPostsPanel() {
  const [posts, setPosts] = useState<ReadyXhsPost[]>([]);
  const [jobs, setJobs] = useState<LocalPublishJobSummary[]>([]);
  const [batches, setBatches] = useState<PublishBatch[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [recoveryBusyJobId, setRecoveryBusyJobId] = useState('');
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
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [finalTitle, setFinalTitle] = useState('');
  const [finalCaption, setFinalCaption] = useState('');
  const [finalTags, setFinalTags] = useState('');
  const [mediaKey, setMediaKey] = useState('');
  const copyRequestRef = useRef(0);
  const selectedPostIdRef = useRef<string>();
  const idempotencyKeysRef = useRef<Record<string, string>>({});
  const reconciliationKeysRef = useRef<Record<string, string>>({});

  const selected = useMemo(
    () => posts.find((post) => post.id === selectedId) ?? posts[0],
    [posts, selectedId],
  );
  const activeUnpublishedPosts = useMemo(
    () => posts.filter((post) => post.candidateKind === 'active_unpublished'),
    [posts],
  );
  const pendingBatch = batches.find((batch) =>
    batch.kind === 'bootstrap' && batch.status === 'pending_approval');
  const supersededBatches = batches
    .filter((batch) => batch.kind === 'bootstrap' && batch.status === 'superseded')
    .slice(0, 3);
  const recoverableBatches = batches.filter((batch) =>
    batch.items.some((item) => item.recoveryEvidence));
  const manualUrlError = manualPublicPostError(manualPublicPost);
  const packetReadyPosts = useMemo(
    () => posts.filter((post) => post.candidateKind === 'packet_ready'),
    [posts],
  );
  const movTrialPosts = useMemo(
    () => posts.filter((post) => post.candidateKind === 'mov_compatibility_trial'),
    [posts],
  );
  const mediaChoices = useMemo<MediaChoice[]>(() => {
    if (!selected) return [];
    if (selected.candidateKind === 'mov_compatibility_trial') {
      return (selected.compatibilityTrialVideoUrls ?? []).map((url, index) => ({
        type: 'video' as const,
        index,
        url,
        compatibilityTrial: 'unverified_mov' as const,
      }));
    }
    return [
      ...selected.videoUrls.map((url, index) => ({ type: 'video' as const, index, url })),
      ...(selected.compatibilityTrialVideoUrls ?? []).map((url, index) => ({
        type: 'video' as const,
        index,
        url,
        compatibilityTrial: 'unverified_mov' as const,
      })),
      ...selected.imageUrls.map((url, index) => ({ type: 'image' as const, index, url })),
    ];
  }, [selected]);
  const selectedMedia = mediaChoices.find(
    (choice) => `${choice.compatibilityTrial ?? choice.type}:${choice.index}` === mediaKey,
  ) ?? mediaChoices[0];
  const isMovCompatibilityTrial = selectedMedia?.compatibilityTrial === 'unverified_mov';
  const movTrialIsEligible = selected ? isMovCompatibilityTrialEligible(selected) : false;
  const canonicalVideoUrl = selected ? getCanonicalVideoUrl(selected.videoUrls) : undefined;
  const currentJob = selected
    ? displayedLocalPublishJob(jobs, selected.id)
    : undefined;
  const currentJobStatus = jobStatusCopy(currentJob);
  const currentManualReconciliation = selected
    ? manualReconciliations.find(
        (reconciliation) => reconciliation.notionPageId === selected.id,
      )
    : undefined;
  const currentManualStatus = manualReconciliationStatusCopy(
    currentManualReconciliation,
  );
  const hasActiveManualReconciliation = Boolean(
    currentManualReconciliation &&
      (currentManualReconciliation.status === 'queued' ||
        currentManualReconciliation.status === 'verifying'),
  );
  const hasActiveJob = Boolean(currentJob && isActiveLocalPublishJob(currentJob));
  const canStartManualReconciliation =
    !currentJob || currentJob.status === 'failed';
  const reviewedTags = tagsFromInput(finalTags);
  const missingTags = getMissingTags(reviewedTags, finalCaption);
  const showTitleCopy = shouldOfferTitleCopy(finalTitle, finalCaption);
  const timing = selected ? publishTiming(selected) : null;
  selectedPostIdRef.current = selected?.id;

  const loadPosts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const path = '/admin/api/ready-posts';
      const response = await fetch(path, { cache: 'no-store' });
      const data = await responseJson<ReadyXhsPostsResponse & ApiError>(
        response,
        `GET ${path}`,
      );
      if (!response.ok) throw new Error(data.error || 'Failed to load ready posts');
      setPosts(data.posts);
      setWarnings(data.warnings);
      setSelectedId((current) =>
        data.posts.some((post) => post.id === current) ? current : data.posts[0]?.id ?? '',
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load ready posts');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBatches = useCallback(async () => {
    try {
      const path = '/admin/api/publish-batches';
      const response = await fetch(path, { cache: 'no-store' });
      const data = await responseJson<PublishBatchesResponse>(response, `GET ${path}`);
      if (!response.ok) throw new Error(data.error || 'Failed to load publish batches');
      setBatches(data.batches);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load publish batches');
    }
  }, []);

  const loadJobs = useCallback(async (showError = false) => {
    try {
      const path = '/admin/api/local-publish-jobs';
      const response = await fetch(path, { cache: 'no-store' });
      const data = await responseJson<LocalJobsResponse>(response, `GET ${path}`);
      if (!response.ok) throw new Error(data.error || 'Failed to load local publish jobs');
      setJobs(data.jobs);
    } catch (loadError) {
      if (showError) {
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load local publish jobs',
        );
      }
    }
  }, []);

  const loadReconciliations = useCallback(async () => {
    try {
      const path = '/admin/api/external-post-reconciliations';
      const response = await fetch(path, { cache: 'no-store' });
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
  }, []);

  const loadManualReconciliations = useCallback(async (showError = false) => {
    try {
      const path = '/admin/api/manual-reconciliations';
      const response = await fetch(path, { cache: 'no-store' });
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
  }, []);

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
    setCopyStatus(null);
    setShowManualReconciliation(false);
    setManualPublicPost('');
    setManualConfirmed(false);
  }, [selected]);

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
      const response = await fetch(path, {
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

  async function updateBatch(action: 'create' | 'approve') {
      setBatchBusy(true);
      setError('');
      try {
        const path = '/admin/api/publish-batches';
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'create'
            ? { action, kind: 'bootstrap' }
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
  ) {
    const confirmed = window.confirm(
      `Requeue the exact already-approved job for "${title}"?\n\n` +
      `Job ${evidence.jobId}\n` +
      `Batch ${evidence.batchId}\n` +
      `Item ${evidence.itemId}\n` +
      `Manifest ${evidence.manifestHash}\n` +
      `Item hash ${evidence.itemHash}\n` +
      `Source revision ${evidence.snapshotRevision}\n\n` +
      'This preserves the same job, frozen snapshot, hashes, publish time, and original approval. ' +
      'It does not approve again or create a replacement job.',
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
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exactEvidence, confirmed: true }),
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

  async function reconcileSelected() {
      if (!selected || !manualConfirmed || !manualPublicPost.trim()) return;
      const idempotencyKey =
        reconciliationKeysRef.current[selected.id] ?? crypto.randomUUID();
      reconciliationKeysRef.current[selected.id] = idempotencyKey;
      setManualSubmitting(true);
      setManualReconciliationError('');
      try {
        const path = '/admin/api/manual-reconciliations';
        const response = await fetch(path, {
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
        const response = await fetch(path, {
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
      copyRequestRef.current === requestId &&
      selectedPostIdRef.current === postId
    ) {
      setCopyStatus(result);
    }
  }

  function postButton(post: ReadyXhsPost) {
    const job = jobs.find((candidate) => candidate.notionPageId === post.id);
    const isTrialOnly = post.candidateKind === 'mov_compatibility_trial';
    const batchItem = batches.flatMap((batch) => batch.items)
      .find((item) => item.notionPageId === post.id);
    const trustedAssetCount = post.videoUrls.length +
      (post.compatibilityTrialVideoUrls?.length ?? 0) +
      post.imageUrls.length;
    return (
      <button
        className={`${styles.postButton} ${
          selected?.id === post.id ? styles.postButtonSelected : ''
        } ${isTrialOnly ? styles.postButtonTrial : ''}`}
        key={post.id}
        type="button"
        onClick={() => {
          setSelectedId(post.id);
          setError('');
        }}
      >
        <span className={styles.postTitle}>{post.headline || 'Untitled post'}</span>
        <span className={isTrialOnly ? styles.trialRowLabel : styles.readyRowLabel}>
          {isTrialOnly
            ? 'MOV staging trial only'
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
            Review the final RedNote copy and queue a trusted packet for the Mac-local browser
            worker. Only a verified RedNote post is backfilled as Published.
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

      <section className={styles.batchApproval} aria-labelledby="batch-approval-heading">
        <div className={styles.queueHeading}>
          <div>
            <h3 id="batch-approval-heading">Bounded batch approval</h3>
            <p>
              One approval authorizes only the exact frozen items and manifest hash shown here.
              Changed items are invalidated individually.
            </p>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={batchBusy}
            onClick={() => void updateBatch('create')}
          >
            {batchBusy
              ? 'Working…'
              : pendingBatch
                ? 'Rebuild and supersede preview'
                : 'Build bootstrap batch'}
          </button>
        </div>
        {pendingBatch ? (
          <>
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
                      : new Date(item.snapshot.publishAt!).toLocaleString()}
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
            No batch is awaiting approval. Posts without exact times stay visible but are excluded.
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
        {recoverableBatches.map((batch) => (
          <div key={`recovery-${batch.id}`} className={styles.recoveryBatch}>
            <strong>Eligible pre-dispatch recovery</strong>
            <p>
              These exact jobs failed only because bounded-batch bypass was disabled.
              Recovery requeues the existing approved row without another approval.
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
                      ? 'Requeueing exact job…'
                      : 'Confirm exact-job recovery'}
                  </button>
                </li>
              )] : [])}
            </ol>
          </div>
        ))}
      </section>

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

              {selectedMedia?.type === 'video' && (
                <video
                  className={styles.video}
                  controls
                  poster={selected.thumbnailUrl || undefined}
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

              {selected.publishBlockers.length > 0 && (
                <ul className={styles.blockers}>
                  {selected.publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                </ul>
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

              <section className={styles.localQueue} aria-labelledby="local-queue-heading">
                <div className={styles.queueHeading}>
                  <div>
                    <h4 id="local-queue-heading">Local RedNote browser queue</h4>
                    <p>
                      Finalize the copy here. Media is selected only from the canonical server
                      packet and cannot be replaced by a client-provided URL.
                    </p>
                  </div>
                  <span className={styles.primaryPath}>Primary path</span>
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

                {selected.candidateKind === 'packet_ready' && currentManualStatus && (
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

                {selected.candidateKind === 'packet_ready' &&
                  !currentManualReconciliation &&
                  !hasActiveJob &&
                  canStartManualReconciliation && (
                  <div className={styles.manualReconciliation}>
                    <div className={styles.manualReconciliationHeading}>
                      <div>
                        <strong>Already published?</strong>
                        <p>
                          Verify an existing public post and backfill this canonical row.
                          This action never publishes.
                        </p>
                      </div>
                      <button
                        className={styles.reconcileButton}
                        type="button"
                        onClick={() => setShowManualReconciliation((current) => !current)}
                        aria-expanded={showManualReconciliation}
                      >
                        {showManualReconciliation ? 'Cancel' : 'Reconcile'}
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
                            Use the exact query-free public URL or bare note ID. The worker verifies
                            it against the canonical title, caption, and media type.
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
                            I confirm this post is already public and should be verified, not
                            published again.
                          </span>
                        </label>
                        <button
                          className={styles.reconcileSubmit}
                          type="button"
                          onClick={reconcileSelected}
                          disabled={
                            manualSubmitting ||
                            !manualConfirmed ||
                            !manualPublicPost.trim() ||
                            Boolean(manualUrlError)
                          }
                        >
                          {manualSubmitting
                            ? 'Queueing verification…'
                            : 'Queue existing-post verification'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {selected.candidateKind === 'packet_ready' && manualReconciliationError && (
                  <p className={styles.inlineError} role="alert">
                    {manualReconciliationError}
                  </p>
                )}

                <div className={styles.reviewFields}>
                  <label className={styles.reviewField}>
                    <span>Final title</span>
                    <input
                      maxLength={100}
                      value={finalTitle}
                      onChange={(event) => setFinalTitle(event.target.value)}
                      disabled={hasActiveJob || hasActiveManualReconciliation}
                    />
                  </label>
                  <label className={styles.reviewField}>
                    <span>Reviewed caption</span>
                    <textarea
                      maxLength={5000}
                      rows={7}
                      value={finalCaption}
                      onChange={(event) => setFinalCaption(event.target.value)}
                      disabled={hasActiveJob || hasActiveManualReconciliation}
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
                      disabled={hasActiveJob || hasActiveManualReconciliation}
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
                      disabled={hasActiveJob || hasActiveManualReconciliation}
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
                    hasActiveJob ||
                    hasActiveManualReconciliation ||
                    (isMovCompatibilityTrial
                      ? !movTrialIsEligible
                      : selected.candidateKind !== 'packet_ready' ||
                        selected.publishBlockers.length > 0 ||
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

              {selected.candidateKind === 'packet_ready' ? (
                <details className={styles.handoff}>
                <summary>Manual handoff and download controls</summary>
                <p>
                  Use these controls if the local worker is unavailable. Nothing is sent to
                  RedNote until you publish in the Creator tab.
                </p>

                <div className={styles.assetAction}>
                  <div>
                    <strong>Prepare the canonical video</strong>
                    <p>Download the MP4, then select that file in Creator.</p>
                  </div>
                  {canonicalVideoUrl ? (
                    <a
                      className={styles.secondaryButton}
                      href={canonicalVideoUrl}
                      download={getVideoDownloadName(finalTitle, canonicalVideoUrl)}
                      {...SAFE_EXTERNAL_LINK_PROPS}
                    >
                      Download video
                    </a>
                  ) : (
                    <span className={styles.missingAsset}>Canonical MEDIA video unavailable</span>
                  )}
                </div>

                <div className={styles.copyFields}>
                  {showTitleCopy && (
                    <div className={styles.copyField}>
                      <div>
                        <span className={styles.fieldLabel}>Title</span>
                        <p>{finalTitle}</p>
                      </div>
                      <button
                        className={styles.copyButton}
                        type="button"
                        onClick={() => copyField(finalTitle, 'Title')}
                      >
                        Copy title
                      </button>
                    </div>
                  )}
                  <div className={styles.copyField}>
                    <div>
                      <span className={styles.fieldLabel}>Caption</span>
                      <p className={styles.caption}>
                        {finalCaption || 'No RedNote caption provided.'}
                      </p>
                    </div>
                    <button
                      className={styles.copyButton}
                      type="button"
                      onClick={() => copyField(finalCaption, 'Caption')}
                    >
                      Copy caption
                    </button>
                  </div>
                  {missingTags.length > 0 && (
                    <div className={styles.copyField}>
                      <div>
                        <span className={styles.fieldLabel}>Tags not already in the caption</span>
                        <p>{formatTags(missingTags)}</p>
                      </div>
                      <button
                        className={styles.copyButton}
                        type="button"
                        onClick={() => copyField(formatTags(missingTags), 'Tags')}
                      >
                        Copy tags
                      </button>
                    </div>
                  )}
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
                  <a
                    className={styles.creatorButton}
                    href={REDNOTE_CREATOR_PUBLISH_URL}
                    {...SAFE_EXTERNAL_LINK_PROPS}
                  >
                    Open RedNote Creator
                  </a>
                  <a
                    className={styles.linkButton}
                    href={selected.pageUrl}
                    {...SAFE_EXTERNAL_LINK_PROPS}
                  >
                    Open packet in Notion
                  </a>
                </div>
                <p className={styles.backfillNotice}>
                  Manual publishing is not backfilled automatically. Leave Notion unchanged until
                  the exact published RedNote URL and note ID are reconciled.
                </p>
                </details>
              ) : (
                <p className={styles.trialManualHandoffDisabled}>
                  Manual Creator handoff is disabled for unverified MOV trials. Use the staging
                  queue above so the worker enforces the separate publish approval.
                </p>
              )}

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
