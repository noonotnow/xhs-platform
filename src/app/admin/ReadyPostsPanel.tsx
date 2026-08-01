'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalPublishJobSummary, LocalPublishMediaType } from '@/types/local-publish-job';
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

interface ApiError {
  error?: string;
  code?: string;
}

interface LocalJobsResponse extends ApiError {
  jobs: LocalPublishJobSummary[];
}

interface LocalJobResponse extends ApiError {
  job: LocalPublishJobSummary;
}

type CopyStatus = {
  ok: boolean;
  message: string;
};

type MediaChoice = {
  type: LocalPublishMediaType;
  index: number;
  url: string;
};

function tagsFromInput(value: string) {
  return value
    .split(/[,\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean);
}

function jobStatusCopy(job: LocalPublishJobSummary | undefined) {
  if (!job) return null;
  if (job.status === 'queued') {
    return {
      tone: 'pending',
      title: 'Queued for the Mac worker',
      detail: 'Waiting for the local browser worker. This post is not published.',
    };
  }
  if (job.status === 'claimed') {
    return {
      tone: 'pending',
      title: 'Claimed by the Mac worker',
      detail: 'Browser staging or human review is in progress. This post is not published yet.',
    };
  }
  if (job.status === 'ambiguous') {
    return {
      tone: 'warning',
      title: 'Published result needs reconciliation',
      detail:
        'RedNote success was verified, but Notion backfill is incomplete. Do not publish again; retry the same success report.',
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
    title: 'Published and backfilled',
    detail: 'The exact RedNote post was verified before Notion was marked Published.',
  };
}

export default function ReadyPostsPanel() {
  const [posts, setPosts] = useState<ReadyXhsPost[]>([]);
  const [jobs, setJobs] = useState<LocalPublishJobSummary[]>([]);
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

  const selected = useMemo(
    () => posts.find((post) => post.id === selectedId) ?? posts[0],
    [posts, selectedId],
  );
  const mediaChoices = useMemo<MediaChoice[]>(() => {
    if (!selected) return [];
    return [
      ...selected.videoUrls.map((url, index) => ({ type: 'video' as const, index, url })),
      ...selected.imageUrls.map((url, index) => ({ type: 'image' as const, index, url })),
    ];
  }, [selected]);
  const selectedMedia = mediaChoices.find(
    (choice) => `${choice.type}:${choice.index}` === mediaKey,
  ) ?? mediaChoices[0];
  const canonicalVideoUrl = selected ? getCanonicalVideoUrl(selected.videoUrls) : undefined;
  const currentJob = selected
    ? jobs.find((job) => job.notionPageId === selected.id)
    : undefined;
  const currentJobStatus = jobStatusCopy(currentJob);
  const hasActiveJob = currentJob?.status === 'queued' ||
    currentJob?.status === 'claimed' ||
    currentJob?.status === 'ambiguous';
  const reviewedTags = tagsFromInput(finalTags);
  const missingTags = getMissingTags(reviewedTags, finalCaption);
  const showTitleCopy = shouldOfferTitleCopy(finalTitle, finalCaption);
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

  useEffect(() => {
    void loadPosts();
    void loadJobs(true);
  }, [loadJobs, loadPosts]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadJobs(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    setFinalTitle(selected?.headline ?? '');
    setFinalCaption(selected?.caption ?? '');
    setFinalTags(selected?.tags.join(', ') ?? '');
    const firstChoice = selected?.videoUrls.length
      ? 'video:0'
      : selected?.imageUrls.length
        ? 'image:0'
        : '';
    setMediaKey(firstChoice);
    setCopyStatus(null);
  }, [selected]);

  async function queueSelected() {
    if (!selected || !selectedMedia) return;
    const confirmed = window.confirm(
      `Queue "${finalTitle.trim()}" for the local RedNote browser?\n\n` +
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
        }} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh posts'}
        </button>
      </div>

      {warnings.length > 0 && (
        <p className={styles.muted}>Schema notices: {warnings.join(' · ')}</p>
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
          <div className={styles.postList} aria-label="Publish-ready posts">
            {posts.map((post) => {
              const job = jobs.find((candidate) => candidate.notionPageId === post.id);
              return (
                <button
                  className={`${styles.postButton} ${
                    selected?.id === post.id ? styles.postButtonSelected : ''
                  }`}
                  key={post.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(post.id);
                    setError('');
                  }}
                >
                  <span className={styles.postTitle}>{post.headline || 'Untitled post'}</span>
                  <span className={styles.postMeta}>
                    {job ? `Local job: ${job.status}` : post.status || 'No status'} ·{' '}
                    {post.videoUrls.length + post.imageUrls.length} trusted asset
                    {post.videoUrls.length + post.imageUrls.length === 1 ? '' : 's'}
                  </span>
                </button>
              );
            })}
          </div>

          {selected && (
            <article className={styles.detail}>
              <div className={styles.statusRow}>
                <h3 className={styles.detailTitle}>{selected.headline || 'Untitled post'}</h3>
                <span className={styles.badge}>
                  {selected.publishPacketReady ? 'Packet ready' : 'Not ready'}
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
                    {currentJob?.status === 'succeeded' && currentJob.shareUrl && (
                      <a href={currentJob.shareUrl} {...SAFE_EXTERNAL_LINK_PROPS}>
                        Open verified RedNote post
                      </a>
                    )}
                  </div>
                )}

                <div className={styles.reviewFields}>
                  <label className={styles.reviewField}>
                    <span>Final title</span>
                    <input
                      maxLength={100}
                      value={finalTitle}
                      onChange={(event) => setFinalTitle(event.target.value)}
                      disabled={hasActiveJob}
                    />
                  </label>
                  <label className={styles.reviewField}>
                    <span>Final caption</span>
                    <textarea
                      maxLength={5000}
                      rows={7}
                      value={finalCaption}
                      onChange={(event) => setFinalCaption(event.target.value)}
                      disabled={hasActiveJob}
                    />
                  </label>
                  <label className={styles.reviewField}>
                    <span>Final tags</span>
                    <input
                      maxLength={2000}
                      value={finalTags}
                      onChange={(event) => setFinalTags(event.target.value)}
                      placeholder="Comma-separated tags"
                      disabled={hasActiveJob}
                    />
                    <small>Up to 20 tags. A leading # is removed before queueing.</small>
                  </label>
                  <label className={styles.reviewField}>
                    <span>Trusted media</span>
                    <select
                      value={selectedMedia ? `${selectedMedia.type}:${selectedMedia.index}` : ''}
                      onChange={(event) => setMediaKey(event.target.value)}
                      disabled={hasActiveJob}
                    >
                      {mediaChoices.map((choice) => (
                        <option
                          key={`${choice.type}:${choice.index}`}
                          value={`${choice.type}:${choice.index}`}
                        >
                          {choice.type === 'video' ? 'Video' : 'Image'} {choice.index + 1}
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
                    selected.publishBlockers.length > 0 ||
                    !selectedMedia ||
                    !finalTitle.trim() ||
                    !finalCaption.trim()
                  }
                >
                  {queueing ? 'Queueing…' : 'Queue for local RedNote browser'}
                </button>
                <p className={styles.queueNotice}>
                  Queueing and browser staging are not publication. The worker must wait for
                  explicit human approval, verify the exact live post, and report its note ID
                  before this record can become Published.
                </p>
              </section>

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

      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
