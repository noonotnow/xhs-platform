'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export default function AdminPage() {
  const [token, setToken] = useState('');
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

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setStatus('Publishing...');
    try {
      const res = await fetch('/api/xhs/publish', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: publishForm.title,
          desc: publishForm.desc,
          image_urls: publishForm.image_urls.filter(u => u.trim()),
          post_time: publishForm.post_time || undefined,
          topic_keywords: publishForm.topic_keywords
            .split(',')
            .map(k => k.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Published! 🎉 ${JSON.stringify(data)}`);
      } else {
        setStatus(`Error: ${data.error}`);
      }
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
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

      {/* QR Login */}
      <section style={{ marginBottom: 24 }}>
        <h2>2. XHS QR Login</h2>
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
      <section style={{ marginBottom: 24 }}>
        <h2>3. Publish to XHS</h2>
        <form onSubmit={handlePublish}>
          <input
            placeholder="Title"
            value={publishForm.title}
            onChange={e => setPublishForm(p => ({ ...p, title: e.target.value }))}
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <textarea
            placeholder="Description / content"
            value={publishForm.desc}
            onChange={e => setPublishForm(p => ({ ...p, desc: e.target.value }))}
            style={{ width: '100%', padding: 8, marginBottom: 8, minHeight: 100 }}
          />
          <input
            placeholder="Image URL (from R2 or any URL)"
            value={publishForm.image_urls[0]}
            onChange={e => setPublishForm(p => ({ ...p, image_urls: [e.target.value] }))}
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <input
            placeholder="Schedule time (optional): 2026-07-25 12:00:00"
            value={publishForm.post_time}
            onChange={e => setPublishForm(p => ({ ...p, post_time: e.target.value }))}
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <input
            placeholder="Topics (comma separated): travel, food, lifestyle"
            value={publishForm.topic_keywords}
            onChange={e => setPublishForm(p => ({ ...p, topic_keywords: e.target.value }))}
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <button type="submit" disabled={!token || !sessionValid}>
            Publish to XHS
          </button>
        </form>
      </section>

      {/* Status */}
      {status && (
        <section style={{ padding: 12, background: '#f0f0f0', borderRadius: 8, marginTop: 16 }}>
          <strong>Status:</strong> {status}
        </section>
      )}
    </div>
  );
}
