import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { publishVideo } from '@/lib/xhs-microservice';

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { title, desc, video_filepath, cover_filepath, topic_keywords, is_private } = body;

    if (!title || !desc) {
      return NextResponse.json({ error: 'title and desc are required' }, { status: 400 });
    }

    if (!video_filepath) {
      return NextResponse.json({ error: 'video_filepath is required' }, { status: 400 });
    }

    const result = await publishVideo({
      title,
      desc,
      video_file: video_filepath,
      cover_file: cover_filepath || undefined,
      topic_keywords: topic_keywords || [],
      is_private: is_private || false,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    console.error('XHS video publish error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
