const XHS_MICROSERVICE_URL = process.env.XHS_MICROSERVICE_URL;
const XHS_API_KEY = process.env.XHS_API_KEY;

if (!XHS_MICROSERVICE_URL) {
  console.warn('XHS_MICROSERVICE_URL not set - microservice features disabled');
}

async function microserviceRequest(path: string, options: RequestInit = {}) {
  if (!XHS_MICROSERVICE_URL) {
    throw new Error('XHS_MICROSERVICE_URL not configured');
  }
  const url = `${XHS_MICROSERVICE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-Api-Key': XHS_API_KEY || '',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microservice error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function getQRCode() {
  return microserviceRequest('/login/qr');
}

export async function checkLoginStatus() {
  return microserviceRequest('/login/status');
}

export async function getSessionStatus() {
  return microserviceRequest('/session/status');
}

export async function loginWithCookie(cookie: string) {
  return microserviceRequest('/login/cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });
}

export async function uploadImage(file: Buffer, filename: string) {
  if (!XHS_MICROSERVICE_URL) throw new Error('XHS_MICROSERVICE_URL not configured');
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(file)]);
  formData.append('file', blob, filename);
  const res = await fetch(`${XHS_MICROSERVICE_URL}/upload`, {
    method: 'POST',
    headers: { 'X-Api-Key': XHS_API_KEY || '' },
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export interface PublishOptions {
  title: string;
  desc: string;
  files: string[];
  post_time?: string; // "YYYY-MM-DD HH:MM:SS"
  topic_keywords?: string[];
  is_private?: boolean;
}

export async function publishNote(options: PublishOptions) {
  return microserviceRequest('/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}

export interface PublishVideoOptions {
  title: string;
  desc: string;
  video_file: string;
  cover_file?: string;
  topic_keywords?: string[];
  is_private?: boolean;
}

export async function publishVideo(options: PublishVideoOptions) {
  return microserviceRequest('/publish-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}
