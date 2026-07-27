import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { createUploadGrant } from '@/lib/upload-grant';

const MICROSERVICE_URL = process.env.XHS_MICROSERVICE_URL;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;

  if (!MICROSERVICE_URL) {
    return NextResponse.json(
      { error: 'Microservice not configured' },
      { status: 503 }
    );
  }

  try {
    const grant = createUploadGrant();
    return NextResponse.json({
      uploadUrl: `${MICROSERVICE_URL}/upload`,
      uploadToken: grant.token,
      expiresAt: grant.expiresAt,
    });
  } catch (error) {
    console.error('Upload grant error:', error);
    return NextResponse.json(
      { error: 'Upload grants are not configured' },
      { status: 503 },
    );
  }
}
