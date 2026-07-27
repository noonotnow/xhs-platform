import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Public login is disabled' },
    { status: 410 },
  );
}
