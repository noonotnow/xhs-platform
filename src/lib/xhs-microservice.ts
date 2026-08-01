const XHS_MICROSERVICE_URL = process.env.XHS_MICROSERVICE_URL;
const XHS_API_KEY = process.env.XHS_API_KEY;

export interface SafeXhsMicroserviceError {
  valid?: boolean;
  session_type?: string;
  relogin_required?: boolean;
  validation?: {
    method?: string;
    host?: string;
    path?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  detail?: string;
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizedMicroserviceError(responseBody: string): SafeXhsMicroserviceError {
  try {
    const body: unknown = JSON.parse(responseBody);
    if (!body || typeof body !== 'object') {
      return { detail: 'XHS microservice request failed' };
    }

    const record = body as Record<string, unknown>;
    const validation = record.validation && typeof record.validation === 'object'
      ? record.validation as Record<string, unknown>
      : undefined;
    const error = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : undefined;

    return {
      ...(typeof record.valid === 'boolean' ? { valid: record.valid } : {}),
      ...(nonEmptyString(record.session_type)
        ? { session_type: nonEmptyString(record.session_type) }
        : {}),
      ...(typeof record.relogin_required === 'boolean'
        ? { relogin_required: record.relogin_required }
        : {}),
      ...(validation ? {
        validation: {
          ...(nonEmptyString(validation.method)
            ? { method: nonEmptyString(validation.method) }
            : {}),
          ...(nonEmptyString(validation.host)
            ? { host: nonEmptyString(validation.host) }
            : {}),
          ...(nonEmptyString(validation.path)
            ? { path: nonEmptyString(validation.path) }
            : {}),
        },
      } : {}),
      ...(error ? {
        error: {
          ...(nonEmptyString(error.code) ? { code: nonEmptyString(error.code) } : {}),
          ...(nonEmptyString(error.message)
            ? { message: nonEmptyString(error.message) }
            : {}),
        },
      } : {}),
      ...(nonEmptyString(record.detail) ? { detail: nonEmptyString(record.detail) } : {}),
    };
  } catch {
    // Non-JSON upstream bodies are not safe to expose to the browser.
  }
  return { detail: 'XHS microservice request failed' };
}

export class XhsMicroserviceHttpError extends Error {
  readonly detail: string;
  readonly safeBody: SafeXhsMicroserviceError;

  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Microservice error ${status}: ${responseBody}`);
    this.safeBody = sanitizedMicroserviceError(responseBody);
    this.detail =
      this.safeBody.error?.message ||
      this.safeBody.detail ||
      'XHS microservice request failed';
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
