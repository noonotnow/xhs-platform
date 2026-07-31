'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PublishReadyPostResponse,
  ReadyXhsPost,
  ReadyXhsPostsResponse,
} from '@/types/ready-post';
import styles from './ReadyPostsPanel.module.css';
import { responseJson } from '@/lib/response-json';

interface ApiError {
  error?: string;
  code?: string;
  published?: PublishReadyPostResponse;
}

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

  const selected = useMemo(
    () => posts.find((post) => post.id === selectedId) ?? posts[0],
    [posts, selectedId],
  );

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
    const videoUrl = selected.videoUrls.find((url) =>
      url.startsWith('https://images.xhs.justlikekatie.com/videos/assets/'),
    );
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
              <div className={styles.caption}>{selected.caption || 'No Weibo text provided.'}</div>

              {selected.videoUrls[0] && (
                <video
                  className={styles.video}
                  controls
                  poster={selected.thumbnailUrl || undefined}
                  preload="metadata"
                  src={selected.videoUrls[0]}
                >
                  Your browser cannot preview this video.
                </video>
              )}

              {selected.mediaUrls.length > 0 && (
                <ul className={styles.mediaLinks}>
                  {selected.mediaUrls.map((url) => (
                    <li key={url}>
                      <a href={url} target="_blank" rel="noreferrer">Open durable media asset</a>
                    </li>
                  ))}
                </ul>
              )}

              {selected.publishBlockers.length > 0 && (
                <ul className={styles.blockers}>
                  {selected.publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                </ul>
              )}

              <div className={styles.actionRow}>
                <a
                  className={styles.linkButton}
                  href={selected.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Notion
                </a>
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
                  {publishing ? 'Publishing…' : 'Confirm and publish to XHS'}
                </button>
              </div>
              {sessionValid !== true && (
                <p className={styles.muted}>Verify the XHS session above before publishing.</p>
              )}
            </article>
          )}
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      {success && (
        <p className={styles.success} role="status">
          XHS confirmed note {success.noteId}.{' '}
          <a href={success.shareUrl} target="_blank" rel="noreferrer">Open published post</a>
        </p>
      )}
    </section>
  );
}
