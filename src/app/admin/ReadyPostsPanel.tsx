'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PublishReadyPostResponse,
  ReadyXhsPost,
  ReadyXhsPostsResponse,
} from '@/types/ready-post';
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
  published?: PublishReadyPostResponse;
}

type CopyStatus = {
  ok: boolean;
  message: string;
};

export default function ReadyPostsPanel({
  sessionValid,
}: {
  sessionValid: boolean | null;
}) {
  const [posts, setPosts] = useState<ReadyXhsPost[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<PublishReadyPostResponse | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const copyRequestRef = useRef(0);
  const selectedPostIdRef = useRef<string>();

  const selected = useMemo(
    () => posts.find((post) => post.id === selectedId) ?? posts[0],
    [posts, selectedId],
  );
  const canonicalVideoUrl = selected
    ? getCanonicalVideoUrl(selected.videoUrls)
    : undefined;
  const missingTags = selected
    ? getMissingTags(selected.tags, selected.caption)
    : [];
  const showTitleCopy = selected
    ? shouldOfferTitleCopy(selected.headline, selected.caption)
    : false;
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

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  async function publishSelected() {
    if (!selected) return;
    const videoUrl = getCanonicalVideoUrl(selected.videoUrls);
    const confirmed = window.confirm(
      `Publish "${selected.headline}" to XHS now?\n\n` +
      `Video: ${videoUrl || 'No canonical MEDIA MP4'}\n\n` +
      'This is a real publish action and cannot be undone from this admin.',
    );
    if (!confirmed) return;

    setPublishing(true);
    setError('');
    setSuccess(null);
    try {
      const path = `/admin/api/ready-posts/${encodeURIComponent(selected.id)}/publish`;
      const response = await fetch(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmed: true,
            lastEditedTime: selected.lastEditedTime,
          }),
        },
      );
      const data = await responseJson<PublishReadyPostResponse & ApiError>(
        response,
        `POST ${path}`,
      );
      if (!response.ok) {
        if (data.published) setSuccess(data.published);
        throw new Error(data.error || 'Publish failed');
      }

      setSuccess(data);
      setPosts((current) => current.filter((post) => post.id !== selected.id));
      setSelectedId('');
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  async function copyField(
    value: string,
    label: string,
  ) {
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
            Review a publish-ready Rednote packet from the canonical Posts DB. Publishing always
            requires a separate confirmation.
          </p>
        </div>
        <button className={styles.refresh} type="button" onClick={loadPosts} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh posts'}
        </button>
      </div>

      {warnings.length > 0 && (
        <p className={styles.muted}>Schema notices: {warnings.join(' · ')}</p>
      )}

      {loading && posts.length === 0 ? (
        <p className={styles.empty}>Loading publish-ready posts…</p>
      ) : posts.length === 0 ? (
        <p className={styles.empty}>No unpublished Rednote packets are marked ready.</p>
      ) : (
        <div className={styles.workspace}>
          <div className={styles.postList} aria-label="Publish-ready posts">
            {posts.map((post) => (
              <button
                className={`${styles.postButton} ${
                  selected?.id === post.id ? styles.postButtonSelected : ''
                }`}
                key={post.id}
                type="button"
                onClick={() => {
                  setSelectedId(post.id);
                  setError('');
                  setSuccess(null);
                  setCopyStatus(null);
                }}
              >
                <span className={styles.postTitle}>{post.headline || 'Untitled post'}</span>
                <span className={styles.postMeta}>
                  {post.status || 'No status'} · {post.videoUrls.length} video
                  {post.videoUrls.length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
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

              {canonicalVideoUrl && (
                <video
                  className={styles.video}
                  controls
                  poster={selected.thumbnailUrl || undefined}
                  preload="metadata"
                  src={canonicalVideoUrl}
                >
                  Your browser cannot preview this video.
                </video>
              )}

              {selected.publishBlockers.length > 0 && (
                <ul className={styles.blockers}>
                  {selected.publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                </ul>
              )}

              <section className={styles.handoff} aria-labelledby="manual-handoff-heading">
                <div className={styles.handoffHeading}>
                  <div>
                    <h4 id="manual-handoff-heading">Publish manually in Rednote Creator</h4>
                    <p>
                      Recommended fallback while API cookie publishing is under investigation.
                      Nothing is sent to Rednote until you publish in the Creator tab.
                    </p>
                  </div>
                  <span className={styles.recommended}>Recommended</span>
                </div>

                <div className={styles.assetAction}>
                  <div>
                    <strong>1. Prepare the canonical video</strong>
                    <p>
                      Download the MP4. If your browser opens it instead, use the video menu to
                      download it, then select that file in Creator.
                    </p>
                  </div>
                  {canonicalVideoUrl ? (
                    <a
                      className={styles.secondaryButton}
                      href={canonicalVideoUrl}
                      download={getVideoDownloadName(selected.headline, canonicalVideoUrl)}
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
                        <p>{selected.headline}</p>
                      </div>
                      <button
                        className={styles.copyButton}
                        type="button"
                        onClick={() => copyField(selected.headline, 'Title')}
                      >
                        Copy title
                      </button>
                    </div>
                  )}
                  <div className={styles.copyField}>
                    <div>
                      <span className={styles.fieldLabel}>Caption</span>
                      <p className={styles.caption}>
                        {selected.caption || 'No Rednote caption provided.'}
                      </p>
                    </div>
                    <button
                      className={styles.copyButton}
                      type="button"
                      onClick={() => copyField(selected.caption, 'Caption')}
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

                <ol className={styles.checklist}>
                  <li>Download the video and select it in Rednote Creator.</li>
                  <li>Paste the caption, plus the separate title or tags shown above.</li>
                  <li>Review the video, text, cover, and audience settings.</li>
                  <li>Publish on Rednote.</li>
                  <li>Return to Admin to reconcile the Notion record.</li>
                </ol>

                <div className={styles.handoffActions}>
                  <a
                    className={styles.creatorButton}
                    href={REDNOTE_CREATOR_PUBLISH_URL}
                    {...SAFE_EXTERNAL_LINK_PROPS}
                  >
                    Open Rednote Creator
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
                  Opening Creator does not mark this packet Published. Manual publishing is not
                  backfilled automatically; leave the Notion mutation pending until the published
                  Rednote URL can be safely reconciled.
                </p>
              </section>

              <details className={styles.experimental}>
                <summary>Experimental API publisher</summary>
                <p>
                  Uses the current server-side XHS session. Keep this secondary while cookie
                  publishing is being investigated.
                </p>
                <button
                  className={styles.publishButton}
                  type="button"
                  onClick={publishSelected}
                  disabled={
                    publishing ||
                    sessionValid !== true ||
                    selected.publishBlockers.length > 0
                  }
                >
                  {publishing ? 'Publishing…' : 'Confirm API publish to XHS'}
                </button>
                {sessionValid !== true && (
                  <p className={styles.muted}>Verify the XHS session above before API publishing.</p>
                )}
              </details>
            </article>
          )}
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      {success && (
        <p className={styles.success} role="status">
          XHS confirmed note {success.noteId}.{' '}
          <a href={success.shareUrl} {...SAFE_EXTERNAL_LINK_PROPS}>Open published post</a>
        </p>
      )}
    </section>
  );
}
