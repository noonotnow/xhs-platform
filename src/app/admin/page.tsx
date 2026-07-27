'use client';

import { useState, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function AdminPage() {
  const [token, setToken] = useState('');
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

  // Image upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>('file');
  const [isPrivate, setIsPrivate] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  async function checkSession() {
    if (!token) return;
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

  const handleFileSelect = useCallback((file: File) => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setStatus('Invalid file type. Please use JPG, PNG, or WebP.');
      setStatusType('error');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setStatus('File too large. Maximum size is 10MB.');
      setStatusType('error');
      return;
    }
    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setImagePreview(url);
    setStatus('');
  }, []);

  function handleRemoveFile() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setSelectedFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setPublishing(true);
    setStatus('');
    setStatusType('info');

    try {
      let files: string[] = [];

      if (uploadMode === 'file') {
        if (!selectedFile) {
          setStatus('Please select an image file.');
          setStatusType('error');
          setPublishing(false);
          return;
        }
        // Step 1: Upload image to XHS microservice
        setStatus('Uploading image...');
        const formData = new FormData();
        formData.append('file', selectedFile);
        const uploadRes = await fetch('/api/xhs/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData,
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) {
          throw new Error(uploadData.error || 'Upload failed');
        }
        files = [uploadData.filepath];
      }

      // Step 2: Publish
      setStatus('Publishing to XHS...');
      const publishBody: Record<string, unknown> = {
        title: publishForm.title,
        desc: publishForm.desc,
        post_time: publishForm.post_time || undefined,
        is_private: isPrivate,
        topic_keywords: publishForm.topic_keywords
          .split(',')
          .map(k => k.trim())
          .filter(Boolean),
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
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(publishBody),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Published! 🎉 Note ID: ${data.note_id || JSON.stringify(data)}`);
        setStatusType('success');
        handleRemoveFile();
        setPublishForm({ title: '', desc: '', image_urls: [''], post_time: '', topic_keywords: '' });
      } else {
        throw new Error(data.error || 'Publish failed');
      }
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setStatusType('error');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: 20, fontFamily: 'system-ui' }}>
      <h1>XHS Admin</h1>

      {/* Auth */}
      <section style={{ marginBottom: 24 }}>
        <h2>1. Platform Login</h2>
        <input
          type="password"
          placeholder="Paste your JWT token"
          value={token}
          onChange={e => setToken(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        />
        <button onClick={checkSession} disabled={!token}>
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
        <button onClick={loginWithCookie} disabled={!token || !cookieStr.trim()}>
          Save Cookie
        </button>
      </section>

      {/* QR Login */}
      <section style={{ marginBottom: 24 }}>
        <h2>3. XHS QR Login (alternative)</h2>
        <button onClick={startQRLogin} disabled={!token}>
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
              📁 Upload File
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
              {!selectedFile ? (
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
                    <strong>Drag & drop</strong> an image here, or <span style={{ color: '#1a73e8', textDecoration: 'underline' }}>click to browse</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    JPG, PNG, WebP · Max 10MB
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleFileSelect(file);
                    }}
                    style={{ display: 'none' }}
                  />
                </div>
              ) : (
                <div style={{
                  border: '1px solid #d0d0d0', borderRadius: 10, padding: 12, marginBottom: 12,
                  display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa',
                }}>
                  {imagePreview && (
                    <img
                      src={imagePreview}
                      alt="Preview"
                      style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0' }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selectedFile.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                      {formatFileSize(selectedFile.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveFile}
                    style={{
                      background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
                      color: '#999', padding: '4px 8px', borderRadius: 4,
                    }}
                    title="Remove image"
                  >
                    ✕
                  </button>
                </div>
              )}
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
            disabled={!token || !sessionValid || publishing}
            style={{
              width: '100%', padding: '12px 20px', fontSize: 15, fontWeight: 600,
              background: (!token || !sessionValid || publishing) ? '#ccc' : '#e74c3c',
              color: '#fff', border: 'none', borderRadius: 8, cursor: publishing ? 'wait' : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {publishing ? '⏳ Publishing...' : '🚀 Publish to XHS'}
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
