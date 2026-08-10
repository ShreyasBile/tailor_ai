import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logging.
 *
 * Every line carries jobId/stage where available so a failed reconstruction can
 * be reconstructed from logs alone. Request/frame payloads are never logged —
 * they carry biometric data (docs/02 §6).
 */
export interface LogContext {
  jobId?: string;
  userId?: string;
  stage?: string;
  attempt?: number;
  [key: string]: unknown;
}

function emit(level: Level, message: string, ctx: LogContext = {}): void {
  if (RANK[level] < RANK[config().LOG_LEVEL]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'orchestrator',
    message,
    ...ctx,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (m: string, c?: LogContext) => emit('debug', m, c),
  info: (m: string, c?: LogContext) => emit('info', m, c),
  warn: (m: string, c?: LogContext) => emit('warn', m, c),
  error: (m: string, c?: LogContext) => emit('error', m, c),
  child: (base: LogContext) => ({
    debug: (m: string, c?: LogContext) => emit('debug', m, { ...base, ...c }),
    info: (m: string, c?: LogContext) => emit('info', m, { ...base, ...c }),
    warn: (m: string, c?: LogContext) => emit('warn', m, { ...base, ...c }),
    error: (m: string, c?: LogContext) => emit('error', m, { ...base, ...c }),
  }),
};

export type Logger = ReturnType<typeof log.child>;
