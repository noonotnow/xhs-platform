import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';

const MICROSERVICE_URL = process.env.XHS_MICROSERVICE_URL;
const API_KEY = process.env.XHS_API_KEY || '';

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!MICROSERVICE_URL) {
    return NextResponse.json(
      { error: 'Microservice not configured' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    uploadUrl: `${MICROSERVICE_URL}/upload`,
    apiKey: API_KEY,
  });
}
