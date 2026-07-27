import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { publishVideo } from '@/lib/xhs-microservice';

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let videoPath: string | undefined;
  let coverPath: string | undefined;

  try {
    const body = await request.json();
    const { title, desc, video_filepath, cover_filepath, topic_keywords, is_private } = body;
    videoPath = video_filepath;
    coverPath = cover_filepath;

    if (!title || !desc) {
      return NextResponse.json({ error: 'title and desc are required' }, { status: 400 });
    }

    if (!video_filepath) {
      return NextResponse.json({ error: 'video_filepath is required' }, { status: 400 });
    }

    const warnings: string[] = [];
    if (!cover_filepath) {
      warnings.push('No cover image provided. XHS will auto-generate one from the video, which may produce a low-quality or null cover URL.');
    }

    const result = await publishVideo({
      title,
      desc,
      video_file: video_filepath,
      cover_file: cover_filepath || undefined,
      topic_keywords: topic_keywords || [],
      is_private: is_private || false,
    });

    return NextResponse.json(
      { ...result, ...(warnings.length > 0 ? { warnings } : {}) },
      { status: 201 },
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('XHS video publish error:', {
      message,
      video_filepath: videoPath ?? '(unknown)',
      cover_filepath: coverPath ?? '(none)',
      stack: e instanceof Error ? e.stack : undefined,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
