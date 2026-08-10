/** Shared queue and channel names. Imported by both API and orchestrator. */

export const RECONSTRUCTION_QUEUE = 'reconstruction';

/** Redis pub/sub channel carrying job progress. One channel per job. */
export function jobChannel(jobId: string): string {
  return `job:${jobId}:events`;
}

/** Replay buffer so an SSE client reconnecting with Last-Event-ID catches up. */
export function jobEventLog(jobId: string): string {
  return `job:${jobId}:log`;
}

export const JOB_EVENT_LOG_TTL_SECONDS = 3600;

export interface ReconstructionJobData {
  jobId: string;
  userId: string;
  sessionId: string;
  options: { quality: 'fast' | 'standard' | 'high'; textured: boolean };
}
