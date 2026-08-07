import { NextResponse } from 'next/server';

interface RednoteHttpError {
  code: string;
  status: number;
  message: string;
}

function knownError(error: unknown): RednoteHttpError | null {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'status' in error &&
    'message' in error &&
    typeof error.code === 'string' &&
    typeof error.status === 'number' &&
    typeof error.message === 'string'
  ) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
    };
  }
  return null;
}

function headers(status: number) {
  return {
    'Cache-Control': 'no-store',
    ...(status === 401
      ? { 'WWW-Authenticate': 'Bearer realm="rednote-publishing"' }
      : {}),
  };
}

export function rednoteJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: headers(status) });
}

export function rednoteErrorResponse(
  error: unknown,
  context: Readonly<Record<string, string | undefined>> = {},
) {
  const normalized = knownError(error);
  const status = normalized?.status ?? 500;
  const code = normalized?.code ?? 'REDNOTE_INTERNAL_ERROR';
  if (status >= 500) {
    console.error('Rednote control-plane request failed', {
      ...context,
      code,
      status,
    });
  }
  return rednoteJson(
    {
      error: normalized?.message ?? 'Rednote control-plane request failed',
      code,
    },
    status,
  );
}
