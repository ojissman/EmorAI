import { authenticateV1, scopeFailure } from '@/lib/api/auth';
import { openAiAuthFailure } from '@/lib/api/protocol/openai';
import { queryVideoJob } from '@/lib/ai/media';

export const runtime = 'nodejs';
export const maxDuration = 60;

function openAiError(status: number, code: string, message: string, type = 'invalid_request_error') {
  return Response.json({ error: { message, type, code } }, { status });
}

/** Video task status polling: GET /api/v1/videos/generations/{task_id} */
export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return openAiAuthFailure(auth.error);
  const mediaScope = scopeFailure(auth.key, 'media');
  if (mediaScope) return openAiAuthFailure(mediaScope);

  const { taskId } = await params;
  try {
    const job = await queryVideoJob(taskId);
    return Response.json({
      id: taskId,
      task_status: job.status === 'success' ? 'SUCCESS' : job.status === 'failed' ? 'FAIL' : 'PROCESSING',
      ...(job.videoUrl ? { video_result: [{ url: job.videoUrl }], video_url: job.videoUrl } : {}),
    });
  } catch (e) {
    return openAiError(502, 'video_status_failed', `Failed to query task status: ${(e as Error).message.slice(0, 240)}`, 'provider_error');
  }
}
