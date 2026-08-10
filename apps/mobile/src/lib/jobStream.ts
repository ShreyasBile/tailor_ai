import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, tokens } from './api';
import { request } from './api';

/**
 * Live job progress.
 *
 * React Native has no EventSource, and even if it did, mobile connections drop
 * constantly — the app is backgrounded mid-scan as a matter of course. So:
 * stream via fetch, resume with Last-Event-ID, and fall back to polling after
 * repeated failures. The user should never learn that the transport had a bad
 * time; they should just see progress.
 */

export type JobEvent =
  | {
      event: 'stage';
      jobId: string;
      stage: string;
      status: string;
      jobStatus: string;
      progress: number;
      at: string;
    }
  | { event: 'completed'; jobId: string; bodyCoreId: string; renderId: string; at: string }
  | {
      event: 'failed';
      jobId: string;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      at: string;
    }
  | { event: 'cancelled'; jobId: string; at: string }
  | { event: 'heartbeat'; at: string };

export interface JobProgress {
  status: string;
  stage: string | null;
  progress: number;
  result: { bodyCoreId: string; renderId: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  /** True while degraded to polling. Diagnostic only — never surfaced as an error. */
  polling: boolean;
}

const MAX_STREAM_ATTEMPTS = 2;
const POLL_INTERVAL_MS = 3000;

/** Human-readable stage names. The user sees these, so they say what we're doing. */
export const STAGE_LABELS: Record<string, string> = {
  S1_VALIDATE: 'Checking your photos',
  S2_EXTRACT: 'Reading your video',
  S3_SELECT: 'Picking the best frames',
  S4_SEGMENT: 'Finding you in the frame',
  S5_BODY_INFERENCE: 'Building your body model',
  S6_FUSE: 'Combining every angle',
  S7_SCALE: 'Working out your proportions',
  S8_RETARGET: 'Refining the model',
  S9_UNWRAP: 'Preparing the surface',
  S10_TEXTURE_BAKE: 'Painting your texture',
  S11_OPTIMISE: 'Polishing the mesh',
  S12_EXPORT: 'Packaging your avatar',
};

export function useJobStream(jobId: string | null): JobProgress {
  const [state, setState] = useState<JobProgress>({
    status: 'QUEUED',
    stage: null,
    progress: 0,
    result: null,
    error: null,
    polling: false,
  });

  const cancelled = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    cancelled.current = false;

    let lastEventId = 0;
    let attempts = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const applyEvent = (event: JobEvent): boolean => {
      if (event.event === 'stage') {
        setState((s) => ({
          ...s,
          status: event.jobStatus,
          stage: event.stage,
          progress: event.progress,
        }));
        return false;
      }
      if (event.event === 'completed') {
        setState((s) => ({
          ...s,
          status: 'COMPLETED',
          progress: 1,
          result: { bodyCoreId: event.bodyCoreId, renderId: event.renderId },
        }));
        return true;
      }
      if (event.event === 'failed') {
        setState((s) => ({
          ...s,
          status: 'FAILED',
          error: {
            code: event.errorCode,
            message: event.errorMessage,
            retryable: event.retryable,
          },
        }));
        return true;
      }
      if (event.event === 'cancelled') {
        setState((s) => ({ ...s, status: 'CANCELLED' }));
        return true;
      }
      return false;
    };

    const startPolling = (): void => {
      setState((s) => ({ ...s, polling: true }));
      pollTimer = setInterval(async () => {
        if (cancelled.current) return;
        try {
          const job = await request<{
            status: string;
            progress: number;
            errorCode: string | null;
            errorMessage: string | null;
            result: { bodyCoreId: string; renderId: string } | null;
            stages: Array<{ name: string; status: string }>;
          }>(`/jobs/${jobId}`);

          const running = job.stages.find((s) => s.status === 'RUNNING');

          setState((s) => ({
            ...s,
            status: job.status,
            progress: job.progress,
            stage: running?.name ?? s.stage,
            result: job.result,
            error: job.errorCode
              ? { code: job.errorCode, message: job.errorMessage ?? '', retryable: false }
              : null,
          }));

          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && pollTimer) {
            clearInterval(pollTimer);
          }
        } catch {
          /* keep polling; transient */
        }
      }, POLL_INTERVAL_MS);
    };

    const stream = async (): Promise<void> => {
      while (!cancelled.current && attempts < MAX_STREAM_ATTEMPTS) {
        try {
          const { access } = await tokens.get();
          // EventSource cannot set headers, and React Native's fetch stream
          // support is uneven — the token goes on the query string, which the
          // API permits for this route only.
          const res = await fetch(
            `${apiBaseUrl}/jobs/${jobId}/events?access_token=${access ?? ''}`,
            {
              headers: {
                accept: 'text/event-stream',
                ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
              },
            },
          );

          if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

          const reader = (res.body as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!cancelled.current) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by a blank line.
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';

            for (const frame of frames) {
              let id: number | null = null;
              let data: string | null = null;

              for (const line of frame.split('\n')) {
                if (line.startsWith('id:')) id = Number(line.slice(3).trim());
                else if (line.startsWith('data:')) data = line.slice(5).trim();
              }

              if (id !== null) lastEventId = id;
              if (!data) continue;

              try {
                if (applyEvent(JSON.parse(data) as JobEvent)) {
                  reader.cancel().catch(() => undefined);
                  return;
                }
              } catch {
                /* malformed frame — skip */
              }
            }
          }

          return;
        } catch {
          attempts += 1;
          if (attempts >= MAX_STREAM_ATTEMPTS) {
            startPolling();
            return;
          }
          await new Promise((r) => setTimeout(r, 1000 * attempts));
        }
      }
    };

    void stream();

    return () => {
      cancelled.current = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [jobId]);

  return state;
}
