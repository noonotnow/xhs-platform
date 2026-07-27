'use client';

import { useState, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_IMAGES = 9;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function AdminPage() {
  const [cookieStr, setCookieStr] = useState('');
  const [qrData, setQrData] = useState<{ url?: string } | null>(null);
  const [sessionValid, setSessionValid] = useState<boolean | null>(null);
  const [publishForm, setPublishForm] = useState({
    title: '',
    desc: '',
    image_urls: [''],
    post_time: '',
    topic_keywords: '',
  });
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState<'info' | 'success' | 'error'>('info');

  // Content type
  const [contentType, setContentType] = useState<'images' | 'video'>('images');

  // Multi-image upload state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>('file');
  const [isPrivate, setIsPrivate] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Video upload state
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [videoDragOver, setVideoDragOver] = useState(false);
  const [coverDragOver, setCoverDragOver] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  async function checkSession() {
    try {
      const res = await fetch('/api/xhs/session', { headers });
      const data = await res.json();
      setSessionValid(data.valid);
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  async function startQRLogin() {
    setStatus('Getting QR code...');
    try {
      const res = await fetch('/api/xhs/login/qr', { headers });
      const data = await res.json();
      setQrData(data);
      setStatus('Scan the QR code with your XHS app');
      pollLoginStatus();
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  async function loginWithCookie() {
    if (!cookieStr.trim()) return;
    setStatus('Saving cookie...');
    try {
      const res = await fetch('/api/xhs/login/cookie', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cookie: cookieStr }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('Cookie saved! ✅ Check session to verify.');
        setSessionValid(null);
      } else {
        setStatus(`Error: ${data.error}`);
      }
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  function pollLoginStatus() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/xhs/login/status', { headers });
        const data = await res.json();
        if (data.code_status === 2) {
          setStatus('Login successful! ✅');
          setSessionValid(true);
          setQrData(null);
          clearInterval(interval);
        } else if (data.code_status === 1) {
          setStatus('QR scanned, confirming...');
        }
      } catch {
        clearInterval(interval);
        setStatus('Polling failed');
      }
    }, 2000);
    // Stop after 2 minutes
    setTimeout(() => clearInterval(interval), 120000);
  }

  const handleFileSelect = useCallback((newFiles: File[]) => {
    const validFiles: File[] = [];
    for (const file of newFiles) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setStatus(`Skipped ${file.name}: invalid type. Use JPG, PNG, or WebP.`);
        setStatusType('error');
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        setStatus(`Skipped ${file.name}: too large (max 10MB).`);
        setStatusType('error');
        continue;
      }
      validFiles.push(file);
    }

    setSelectedFiles(prev => {
      const total = prev.length + validFiles.length;
      if (total > MAX_IMAGES) {
        const allowed = validFiles.slice(0, MAX_IMAGES - prev.length);
        setStatus(`Maximum ${MAX_IMAGES} images. ${validFiles.length - allowed.length} file(s) skipped.`);
        setStatusType('error');
        const urls = allowed.map(f => URL.createObjectURL(f));
        setImagePreviews(p => [...p, ...urls]);
        return [...prev, ...allowed];
      }
      const urls = validFiles.map(f => URL.createObjectURL(f));
      setImagePreviews(p => [...p, ...urls]);
      if (validFiles.length > 0) setStatus('');
      return [...prev, ...validFiles];
    });
  }, []);

  function handleRemoveFile(index: number) {
    URL.revokeObjectURL(imagePreviews[index]);
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    setImagePreviews(prev => prev.filter((_, i) => i !== index));
  }

  function handleRemoveAllFiles() {
    imagePreviews.forEach(url => URL.revokeObjectURL(url));
    setSelectedFiles([]);
    setImagePreviews([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFileSelect(files);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  // Video handlers
  const handleVideoSelect = useCallback((file: File) => {
    if (!VIDEO_TYPES.includes(file.type)) {
      setStatus('Invalid file type. Use MP4, MOV, or WebM.');
      setStatusType('error');
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      setStatus('Video too large. Maximum size is 100MB.');
      setStatusType('error');
      return;
    }
    setVideoFile(file);
    setVideoPreviewUrl(URL.createObjectURL(file));
    setStatus('');
  }, []);

  function handleRemoveVideo() {
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    setVideoFile(null);
    setVideoPreviewUrl(null);
    if (videoInputRef.current) videoInputRef.current.value = '';
  }

  const handleCoverSelect = useCallback((file: File) => {
    if (!IMAGE_TYPES.includes(file.type)) {
      setStatus('Invalid cover type. Use JPG, PNG, or WebP.');
      setStatusType('error');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setStatus('Cover image too large. Maximum size is 10MB.');
      setStatusType('error');
      return;
    }
    setCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
    setStatus('');
  }, []);

  function handleRemoveCover() {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverFile(null);
    setCoverPreview(null);
    if (coverInputRef.current) coverInputRef.current.value = '';
  }

  async function getUploadConfig(): Promise<{ uploadUrl: string; uploadToken: string }> {
    const res = await fetch('/api/xhs/upload-config');
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to get upload config');
    }
    return res.json();
  }

  async function uploadFileToServer(file: File): Promise<string> {
    // Upload directly to the microservice, bypassing Vercel's 4.5MB body limit
    const { uploadUrl, uploadToken } = await getUploadConfig();
    const formData = new FormData();
    formData.append('file', file, file.name);
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Authorization': `Upload ${uploadToken}` },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Upload failed: ${errText}`);
    }
    const data = await res.json();
    return data.filepath;
  }

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setPublishing(true);
    setStatus('');
    setStatusType('info');
    setPublishProgress('');

    try {
      const topicKeywords = publishForm.topic_keywords
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);

      if (contentType === 'video') {
        // Video publish flow
        if (!videoFile) {
          setStatus('Please select a video file.');
          setStatusType('error');
          setPublishing(false);
          return;
        }

        // Warn if no cover image
        if (!coverFile) {
          const proceed = window.confirm(
            'No cover image selected.\n\n' +
            'XHS will auto-generate a cover from the video, which often produces a low-quality or blank thumbnail.\n\n' +
            'Publish without a cover image anyway?'
          );
          if (!proceed) {
            setPublishing(false);
            return;
          }
        }

        // Upload video
        setPublishProgress('Uploading video...');
        const videoFilepath = await uploadFileToServer(videoFile);

        // Upload cover if provided
        let coverFilepath: string | undefined;
        if (coverFile) {
          setPublishProgress('Uploading cover image...');
          coverFilepath = await uploadFileToServer(coverFile);
        }

        // Publish
        setPublishProgress('Publishing video to XHS...');
        const res = await fetch('/api/xhs/publish-video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: publishForm.title,
            desc: publishForm.desc,
            video_filepath: videoFilepath,
            cover_filepath: coverFilepath,
            topic_keywords: topicKeywords,
            is_private: isPrivate,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          const noteId = data?.data?.id || data?.note_id || '';
          const shareLink = data?.data?.share_link || data?.share_link || '';
          let successMsg = `Video published! 🎉${noteId ? ` Note ID: ${noteId}` : ''}${shareLink ? ` | Link: ${shareLink}` : ''}`;
          if (data.warnings && data.warnings.length > 0) {
            successMsg += ` ⚠️ ${data.warnings.join('. ')}`;
          }
          setStatus(successMsg);
          setStatusType('success');
          handleRemoveVideo();
          handleRemoveCover();
          setPublishForm({ title: '', desc: '', image_urls: [''], post_time: '', topic_keywords: '' });
        } else {
          throw new Error(data.error || 'Publish failed');
        }
      } else {
        // Image publish flow
        const files: string[] = [];

        if (uploadMode === 'file') {
          if (selectedFiles.length === 0) {
            setStatus('Please select at least one image.');
            setStatusType('error');
            setPublishing(false);
            return;
          }

          // Upload all files
          for (let i = 0; i < selectedFiles.length; i++) {
            setPublishProgress(`Uploading image ${i + 1}/${selectedFiles.length}...`);
            const filepath = await uploadFileToServer(selectedFiles[i]);
            files.push(filepath);
          }
        }

        // Publish
        setPublishProgress('Publishing to XHS...');
        const publishBody: Record<string, unknown> = {
          title: publishForm.title,
          desc: publishForm.desc,
          post_time: publishForm.post_time || undefined,
          is_private: isPrivate,
          topic_keywords: topicKeywords,
        };

        if (uploadMode === 'file') {
          publishBody.files = files;
        } else {
          publishBody.image_urls = publishForm.image_urls.filter(u => u.trim());
        }

        const res = await fetch('/api/xhs/publish', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(publishBody),
        });
        const data = await res.json();
        if (res.ok) {
          const noteId = data?.data?.id || data?.note_id || '';
          const shareLink = data?.data?.share_link || data?.share_link || '';
          setStatus(`Published! 🎉${noteId ? ` Note ID: ${noteId}` : ''}${shareLink ? ` | Link: ${shareLink}` : ''}`);
          setStatusType('success');
          handleRemoveAllFiles();
          setPublishForm({ title: '', desc: '', image_urls: [''], post_time: '', topic_keywords: '' });
        } else {
          throw new Error(data.error || 'Publish failed');
        }
      }
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setStatusType('error');
    } finally {
      setPublishing(false);
      setPublishProgress('');
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: 20, fontFamily: 'system-ui' }}>
      <h1>XHS Admin</h1>

      {/* Cloudflare Access authenticates the operator before this route renders. */}
      <section style={{ marginBottom: 24 }}>
        <h2>1. XHS Session</h2>
        <button onClick={checkSession}>
          Check XHS Session
        </button>
        <p>XHS Session: {sessionValid === null ? '—' : sessionValid ? '✅ Valid' : '❌ Expired'}</p>
      </section>

      {/* Cookie Login (manual) */}
      <section style={{ marginBottom: 24, padding: 16, background: '#f9f9f9', borderRadius: 8, border: '1px solid #e0e0e0' }}>
        <h2>2. XHS Cookie Login (easiest)</h2>
        <p style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
          Go to <a href="https://www.xiaohongshu.com" target="_blank" rel="noreferrer">xiaohongshu.com</a> → log in → 
          open DevTools (F12) → Console → type <code>document.cookie</code> → copy the result
        </p>
        <textarea
          placeholder="Paste your XHS cookie string here..."
          value={cookieStr}
          onChange={e => setCookieStr(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8, minHeight: 60, fontSize: 12 }}
        />
        <button onClick={loginWithCookie} disabled={!cookieStr.trim()}>
          Save Cookie
        </button>
      </section>

      {/* QR Login */}
      <section style={{ marginBottom: 24 }}>
        <h2>3. XHS QR Login (alternative)</h2>
        <button onClick={startQRLogin}>
          Start QR Login
        </button>
        {qrData && qrData.url && (
          <div style={{ marginTop: 12 }}>
            <div style={{ background: '#fff', padding: 16, display: 'inline-block', borderRadius: 8, border: '1px solid #ddd' }}>
              <QRCodeSVG value={qrData.url} size={256} level="M" />
            </div>
            <div style={{ marginTop: 12 }}>
              <button onClick={startQRLogin} style={{ marginRight: 8 }}>
                🔄 Refresh QR
              </button>
              <span style={{ fontSize: 12, color: '#666' }}>QR codes expire in ~60s</span>
            </div>
            <p style={{ marginTop: 8, fontSize: 12, color: '#666', wordBreak: 'break-all' }}>
              Fallback URL: <a href={qrData.url}>{qrData.url}</a>
            </p>
          </div>
        )}
      </section>

      {/* Publish */}
      <section style={{ marginBottom: 24, padding: 20, background: '#fff', borderRadius: 12, border: '1px solid #e0e0e0' }}>
        <h2 style={{ marginTop: 0 }}>4. Publish to XHS</h2>
        <form onSubmit={handlePublish}>
          {/* Title */}
          <input
            placeholder="Title *"
            value={publishForm.title}
            onChange={e => setPublishForm(p => ({ ...p, title: e.target.value }))}
            required
            style={{ width: '100%', padding: 10, marginBottom: 12, borderRadius: 6, border: '1px solid #d0d0d0', fontSize: 14, boxSizing: 'border-box' }}
          />

          {/* Description */}
          <textarea
            placeholder="Description / content *"
            value={publishForm.desc}
            onChange={e => setPublishForm(p => ({ ...p, desc: e.target.value }))}
            required
            style={{ width: '100%', padding: 10, marginBottom: 12, borderRadius: 6, border: '1px solid #d0d0d0', minHeight: 100, fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
          />

          {/* Content type toggle */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setContentType('images')}
              style={{
                flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                border: '1px solid #d0d0d0', borderRadius: '6px 0 0 6px',
                background: contentType === 'images' ? '#1a73e8' : '#f5f5f5',
                color: contentType === 'images' ? '#fff' : '#333',
                fontWeight: contentType === 'images' ? 600 : 400,
              }}
            >
              🖼️ Images
            </button>
            <button
              type="button"
              onClick={() => setContentType('video')}
              style={{
                flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                border: '1px solid #d0d0d0', borderLeft: 'none', borderRadius: '0 6px 6px 0',
                background: contentType === 'video' ? '#7c3aed' : '#f5f5f5',
                color: contentType === 'video' ? '#fff' : '#333',
                fontWeight: contentType === 'video' ? 600 : 400,
              }}
            >
              🎬 Video
            </button>
          </div>

          {/* ===== IMAGE MODE ===== */}
          {contentType === 'images' && (
            <>
              {/* Image source toggle */}
              <div style={{ display: 'flex', gap: 0, marginBottom: 12 }}>
                <button
                  type="button"
                  onClick={() => setUploadMode('file')}
                  style={{
                    flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                    border: '1px solid #d0d0d0', borderRadius: '6px 0 0 6px',
                    background: uploadMode === 'file' ? '#1a73e8' : '#f5f5f5',
                    color: uploadMode === 'file' ? '#fff' : '#333',
                    fontWeight: uploadMode === 'file' ? 600 : 400,
                  }}
                >
                  📁 Upload Files
                </button>
                <button
                  type="button"
                  onClick={() => setUploadMode('url')}
                  style={{
                    flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                    border: '1px solid #d0d0d0', borderLeft: 'none', borderRadius: '0 6px 6px 0',
                    background: uploadMode === 'url' ? '#1a73e8' : '#f5f5f5',
                    color: uploadMode === 'url' ? '#fff' : '#333',
                    fontWeight: uploadMode === 'url' ? 600 : 400,
                  }}
                >
                  🔗 Image URL
                </button>
              </div>

              {/* File Upload Mode */}
              {uploadMode === 'file' && (
                <>
                  {/* Image preview grid */}
                  {selectedFiles.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 13, color: '#555', fontWeight: 500 }}>
                          {selectedFiles.length}/{MAX_IMAGES} images
                        </span>
                        <button
                          type="button"
                          onClick={handleRemoveAllFiles}
                          style={{ fontSize: 12, color: '#e74c3c', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          Remove all
                        </button>
                      </div>
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: 8,
                      }}>
                        {selectedFiles.map((file, i) => (
                          <div key={i} style={{ position: 'relative', paddingBottom: '100%' }}>
                            <img
                              src={imagePreviews[i]}
                              alt={file.name}
                              style={{
                                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveFile(i)}
                              style={{
                                position: 'absolute', top: 4, right: 4,
                                width: 22, height: 22, borderRadius: '50%',
                                background: 'rgba(220, 38, 38, 0.85)', color: '#fff',
                                border: 'none', fontSize: 12, cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                lineHeight: 1,
                              }}
                              title={`Remove ${file.name}`}
                            >
                              ✕
                            </button>
                            <div style={{
                              position: 'absolute', bottom: 4, left: 4, right: 4,
                              fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.5)',
                              borderRadius: 4, padding: '2px 4px', overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {formatFileSize(file.size)}
                            </div>
                          </div>
                        ))}

                        {/* Add more card */}
                        {selectedFiles.length < MAX_IMAGES && (
                          <div
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                              position: 'relative', paddingBottom: '100%', cursor: 'pointer',
                            }}
                          >
                            <div style={{
                              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                              border: '2px dashed #ccc', borderRadius: 8,
                              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                              background: '#fafafa', transition: 'border-color 0.2s',
                            }}>
                              <div style={{ fontSize: 24, color: '#999' }}>+</div>
                              <div style={{ fontSize: 11, color: '#999' }}>Add</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Drop zone (shown when no files or alongside grid via the + card) */}
                  {selectedFiles.length === 0 && (
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onClick={() => fileInputRef.current?.click()}
                      style={{
                        border: `2px dashed ${dragOver ? '#1a73e8' : '#ccc'}`,
                        borderRadius: 10,
                        padding: '32px 20px',
                        textAlign: 'center',
                        cursor: 'pointer',
                        marginBottom: 12,
                        background: dragOver ? '#e8f0fe' : '#fafafa',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{ fontSize: 36, marginBottom: 8 }}>📷</div>
                      <div style={{ fontSize: 14, color: '#555', marginBottom: 4 }}>
                        <strong>Drag & drop</strong> images here, or <span style={{ color: '#1a73e8', textDecoration: 'underline' }}>click to browse</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#999' }}>
                        JPG, PNG, WebP · Max 10MB each · Up to {MAX_IMAGES} images
                      </div>
                    </div>
                  )}

                  {/* Hidden file input with onDrop handler on grid area too */}
                  {selectedFiles.length > 0 && (
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      style={{ marginBottom: 4 }}
                    />
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp"
                    multiple
                    onChange={e => {
                      const files = Array.from(e.target.files || []);
                      if (files.length > 0) handleFileSelect(files);
                      e.target.value = '';
                    }}
                    style={{ display: 'none' }}
                  />
                </>
              )}

              {/* URL Mode */}
              {uploadMode === 'url' && (
                <input
                  placeholder="Image URL (from R2 or any public URL)"
                  value={publishForm.image_urls[0]}
                  onChange={e => setPublishForm(p => ({ ...p, image_urls: [e.target.value] }))}
                  style={{ width: '100%', padding: 10, marginBottom: 12, borderRadius: 6, border: '1px solid #d0d0d0', fontSize: 14, boxSizing: 'border-box' }}
                />
              )}
            </>
          )}

          {/* ===== VIDEO MODE ===== */}
          {contentType === 'video' && (
            <>
              {/* Video drop zone */}
              {!videoFile ? (
                <div
                  onDrop={e => {
                    e.preventDefault();
                    setVideoDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) handleVideoSelect(file);
                  }}
                  onDragOver={e => { e.preventDefault(); setVideoDragOver(true); }}
                  onDragLeave={e => { e.preventDefault(); setVideoDragOver(false); }}
                  onClick={() => videoInputRef.current?.click()}
                  style={{
                    border: `2px dashed ${videoDragOver ? '#7c3aed' : '#ccc'}`,
                    borderRadius: 10,
                    padding: '32px 20px',
                    textAlign: 'center',
                    cursor: 'pointer',
                    marginBottom: 12,
                    background: videoDragOver ? '#f3e8ff' : '#fafafa',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ fontSize: 36, marginBottom: 8 }}>🎬</div>
                  <div style={{ fontSize: 14, color: '#555', marginBottom: 4 }}>
                    <strong>Drag & drop</strong> a video here, or <span style={{ color: '#7c3aed', textDecoration: 'underline' }}>click to browse</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    MP4, MOV, WebM · Max 100MB
                  </div>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept=".mp4,.mov,.webm"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleVideoSelect(file);
                    }}
                    style={{ display: 'none' }}
                  />
                </div>
              ) : (
                <div style={{
                  border: '1px solid #d0d0d0', borderRadius: 10, padding: 12, marginBottom: 12,
                  background: '#faf5ff',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#7c3aed' }}>🎬 Video</span>
                    <button
                      type="button"
                      onClick={handleRemoveVideo}
                      style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#999', padding: '2px 6px' }}
                      title="Remove video"
                    >
                      ✕
                    </button>
                  </div>
                  {videoPreviewUrl && (
                    <video
                      src={videoPreviewUrl}
                      controls
                      style={{ width: '100%', maxHeight: 240, borderRadius: 8, background: '#000', marginBottom: 8 }}
                    />
                  )}
                  <div style={{ fontSize: 12, color: '#888' }}>
                    {videoFile.name} · {formatFileSize(videoFile.size)}
                  </div>
                </div>
              )}

              {/* Cover image drop zone */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#555', marginBottom: 4 }}>
                  📷 Cover Image <span style={{ fontWeight: 600, color: '#d97706' }}>— strongly recommended</span>
                </div>
                <div style={{ fontSize: 11, color: '#b45309', marginBottom: 6, lineHeight: 1.4 }}>
                  ⚠️ Without a cover image, XHS auto-generates one which often results in a blank or low-quality thumbnail.
                </div>
                {!coverFile ? (
                  <div
                    onDrop={e => {
                      e.preventDefault();
                      setCoverDragOver(false);
                      const file = e.dataTransfer.files[0];
                      if (file) handleCoverSelect(file);
                    }}
                    onDragOver={e => { e.preventDefault(); setCoverDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); setCoverDragOver(false); }}
                    onClick={() => coverInputRef.current?.click()}
                    style={{
                      border: `2px dashed ${coverDragOver ? '#7c3aed' : '#ccc'}`,
                      borderRadius: 8,
                      padding: '16px 12px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      background: coverDragOver ? '#f3e8ff' : '#fafafa',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div style={{ fontSize: 13, color: '#888' }}>
                      Drop cover image or <span style={{ color: '#7c3aed', textDecoration: 'underline' }}>browse</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>JPG, PNG, WebP · Max 10MB</div>
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept=".jpg,.jpeg,.png,.webp"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleCoverSelect(file);
                      }}
                      style={{ display: 'none' }}
                    />
                  </div>
                ) : (
                  <div style={{
                    border: '1px solid #d0d0d0', borderRadius: 8, padding: 10,
                    display: 'flex', alignItems: 'center', gap: 10, background: '#faf5ff',
                  }}>
                    {coverPreview && (
                      <img
                        src={coverPreview}
                        alt="Cover"
                        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid #e0e0e0' }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {coverFile.name}
                      </div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>{formatFileSize(coverFile.size)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveCover}
                      style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#999', padding: '2px 6px' }}
                      title="Remove cover"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Topics */}
          <input
            placeholder="Topics (comma separated): travel, food, lifestyle"
            value={publishForm.topic_keywords}
            onChange={e => setPublishForm(p => ({ ...p, topic_keywords: e.target.value }))}
            style={{ width: '100%', padding: 10, marginBottom: 12, borderRadius: 6, border: '1px solid #d0d0d0', fontSize: 14, boxSizing: 'border-box' }}
          />

          {/* Private/Public toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={e => setIsPrivate(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              Private post
            </label>
            <span style={{ fontSize: 12, color: '#888' }}>
              {isPrivate ? '🔒 Only you can see this' : '🌐 Public post'}
            </span>
          </div>

          {/* Schedule time (collapsible) */}
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#666', marginBottom: 8 }}>
              ⏰ Schedule for later (optional)
            </summary>
            <input
              placeholder="Schedule time: 2026-07-25 12:00:00"
              value={publishForm.post_time}
              onChange={e => setPublishForm(p => ({ ...p, post_time: e.target.value }))}
              style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid #d0d0d0', fontSize: 14, boxSizing: 'border-box' }}
            />
          </details>

          {/* Publish button */}
          <button
            type="submit"
            disabled={!sessionValid || publishing}
            style={{
              width: '100%', padding: '12px 20px', fontSize: 15, fontWeight: 600,
              background: (!sessionValid || publishing) ? '#ccc' : contentType === 'video' ? '#7c3aed' : '#e74c3c',
              color: '#fff', border: 'none', borderRadius: 8, cursor: publishing ? 'wait' : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {publishing
              ? `⏳ ${publishProgress || 'Processing...'}`
              : contentType === 'video'
                ? '🎬 Publish Video to XHS'
                : '🚀 Publish to XHS'}
          </button>
        </form>
      </section>

      {/* Status */}
      {status && (
        <section style={{
          padding: 14, borderRadius: 8, marginTop: 16, fontSize: 14,
          background: statusType === 'success' ? '#e6f4ea' : statusType === 'error' ? '#fce8e6' : '#f0f0f0',
          color: statusType === 'success' ? '#1e7e34' : statusType === 'error' ? '#c62828' : '#333',
          border: `1px solid ${statusType === 'success' ? '#a8dab5' : statusType === 'error' ? '#f5c6cb' : '#d0d0d0'}`,
        }}>
          <strong>{statusType === 'success' ? '✅' : statusType === 'error' ? '❌' : 'ℹ️'}</strong> {status}
        </section>
      )}
    </div>
  );
}
