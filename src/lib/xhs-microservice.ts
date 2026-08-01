const XHS_MICROSERVICE_URL = process.env.XHS_MICROSERVICE_URL;
const XHS_API_KEY = process.env.XHS_API_KEY;

function sanitizedMicroserviceDetail(responseBody: string) {
  try {
    const body: unknown = JSON.parse(responseBody);
    if (
      body &&
      typeof body === 'object' &&
      'detail' in body &&
      typeof body.detail === 'string' &&
      body.detail.trim()
    ) {
      return body.detail.trim();
    }
  } catch {
    // Non-JSON upstream bodies are not safe to expose to the browser.
  }
  return 'XHS microservice request failed';
}

export class XhsMicroserviceHttpError extends Error {
  readonly detail: string;

  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Microservice error ${status}: ${responseBody}`);
    this.detail = sanitizedMicroserviceDetail(responseBody);
  }
}

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
    throw new XhsMicroserviceHttpError(res.status, body);
  }
  return res.json();
}

export interface PublishVideoUrlOptions {
  video_url: string;
  title: string;
  caption: string;
  tags?: string[];
}

export interface PublishVideoUrlResponse {
  status: 'success';
  note_id: string;
  share_url: string;
}

export interface QrCodeResponse {
  qr_id: string;
  code: string;
  url: string;
}

export async function publishVideoUrl(
  options: PublishVideoUrlOptions,
): Promise<PublishVideoUrlResponse> {
  if (!XHS_API_KEY) {
    throw new Error('XHS_API_KEY not configured');
  }
  return microserviceRequest('/publish-video-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }) as Promise<PublishVideoUrlResponse>;
}

export async function getQRCode(): Promise<QrCodeResponse> {
  return microserviceRequest('/login/qr') as Promise<QrCodeResponse>;
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
