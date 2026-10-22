'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Check, CircleAlert, Loader2, RotateCcw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { VIEWS, type Job, type ScanReport, type View } from '@/lib/types';
import { RequireUser } from '@/components/guard';
import { VIEW_COPY } from '@/components/pose-guide';
import { Badge, Button, ButtonLink, Card, cx } from '@/components/ui';

// The pipeline's stages, grouped into what a person cares about.
const PHASES = [
  { label: 'Checking your photos', stages: ['S1_VALIDATE', 'S2_EXTRACT', 'S3_SELECT'] },
  { label: 'Finding your joints and outline', stages: ['S3B_SCAN_ANALYZE'], detail: 'and measuring 11 points' },
  { label: 'Building your 3D body', stages: ['S4_SEGMENT', 'S5_BODY_INFERENCE', 'S6_FUSE', 'S7_SCALE', 'S8_RETARGET', 'S9_UNWRAP', 'S10_TEXTURE_BAKE', 'S11_OPTIMISE'] },
  { label: 'Saving your Body Profile', stages: ['S12_EXPORT'] },
];

function phaseState(job: Job, stages: string[]): 'done' | 'active' | 'pending' | 'failed' {
  const rows = job.stages.filter((s) => stages.includes(s.name));
  if (rows.some((s) => s.status === 'FAILED')) return 'failed';
  if (job.status === 'COMPLETED') return 'done';
  if (rows.length === 0 || rows.every((s) => s.status === 'PENDING')) return 'pending';
  if (rows.some((s) => s.status === 'RUNNING')) return 'active';
  if (rows.some((s) => s.status === 'PENDING')) {
    // Some of this group finished, the rest queued: active unless a later
    // group has already started.
    return 'active';
  }
  // Every row in this group finished: done once a later stage has started.
  const last = Math.max(...rows.map((s) => s.sequence));
  return job.stages.some((s) => s.sequence > last) ? 'done' : 'active';
}

function Progress({ jobId }: { jobId: string }) {
  const router = useRouter();
  const { photos } = useSession();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'CANCELLED') return;
      } catch (err) {
        // A malformed id (400) or an unknown one (404) will never resolve, and
        // nor will any other 4xx — stop polling. Network blips, 5xx and 429
        // are transient: keep trying.
        if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
          return setError('This scan was not found.');
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          return setError(err.message);
        }
      }
      timer = setTimeout(tick, 1200);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  const report = (job?.scanReport ?? null) as ScanReport | null;
  const failed = job?.status === 'FAILED';
  const done = job?.status === 'COMPLETED';

  if (error) {
    return (
      <div className="container-page py-20 text-center">
        <p className="text-ink-muted">{error}</p>
        <ButtonLink href="/scan" className="mt-6">
          Start a new scan
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="container-page max-w-5xl py-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
        {/* photos, with a scan sweep while working */}
        <div className="grid grid-cols-4 gap-2 self-start lg:grid-cols-2 lg:gap-3">
          {VIEWS.map((v) => {
            const q = report?.views.find((x) => x.view === v);
            const bad = q && !q.ok;
            return (
              <div
                key={v}
                className={cx(
                  'relative aspect-[3/4] overflow-hidden rounded-xl border bg-black',
                  bad ? 'border-warn ring-4 ring-warn/20' : 'border-line',
                )}
              >
                {photos[v] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photos[v]!.previewUrl} alt={VIEW_COPY[v].title} className="h-full w-full object-contain opacity-90" />
                ) : (
                  <div className="grid h-full place-items-center text-xs text-white/60">{VIEW_COPY[v].title}</div>
                )}
                {!done && !failed && (
                  <div className="pointer-events-none absolute inset-0 overflow-hidden">
                    <div className="h-full animate-scan">
                      <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-emerald-300 to-transparent shadow-[0_0_14px_3px_rgba(110,231,183,0.5)]" />
                    </div>
                  </div>
                )}
                {q && (
                  <span
                    className={cx(
                      'absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-white',
                      bad ? 'bg-warn' : 'bg-good',
                    )}
                  >
                    {bad ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div>
          {!failed && !done && (
            <>
              <p className="eyebrow mb-3">Analysing</p>
              <h1 className="font-display text-5xl">Measuring you…</h1>
              <p className="mt-3 text-ink-muted">This usually takes 20–40 seconds. You can stay on this page.</p>
            </>
          )}
          {done && (
            <>
              <p className="eyebrow mb-3 text-good">Complete</p>
              <h1 className="font-display text-5xl">Your Body Profile is ready</h1>
              {report && (
                <p className="mt-3 text-ink-muted">
                  {report.measurements.length} measurements ·{' '}
                  <span className="font-medium text-ink">{report.confidence.label ?? 'medium'} confidence</span>
                </p>
              )}
            </>
          )}
          {failed && (
            <>
              <p className="eyebrow mb-3 text-warn">Needs attention</p>
              <h1 className="font-display text-5xl">
                {job?.errorCode === 'SCAN_REJECTED' ? 'A few photos need retaking' : "That scan didn't work"}
              </h1>
              <p className="mt-3 text-ink-muted">{job?.errorMessage}</p>
            </>
          )}

          <Card className="mt-8 divide-y divide-line">
            {PHASES.map((p) => {
              const st = job ? phaseState(job, p.stages) : 'pending';
              return (
                <div key={p.label} className="flex items-center gap-4 px-5 py-4">
                  <span
                    className={cx(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-full border',
                      st === 'done' && 'border-good bg-good text-white',
                      st === 'active' && 'border-accent text-accent',
                      st === 'failed' && 'border-warn bg-warn text-white',
                      st === 'pending' && 'border-line text-ink-faint',
                    )}
                  >
                    {st === 'done' ? (
                      <Check className="h-4 w-4" />
                    ) : st === 'active' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : st === 'failed' ? (
                      <CircleAlert className="h-4 w-4" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    )}
                  </span>
                  <div>
                    <p className={cx('font-medium', st === 'pending' && 'text-ink-muted')}>{p.label}</p>
                    {p.detail && <p className="text-xs text-ink-muted">{p.detail}</p>}
                  </div>
                </div>
              );
            })}
          </Card>

          {!failed && !done && job && (
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-black/10">
              <div className="h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          )}

          {failed && report && <Issues report={report} />}
          {/* A scan can pass with warnings (e.g. low-resolution photos): say
              why confidence is lower and how to raise it. */}
          {done && report && report.issues.length > 0 && (
            <>
              <p className="mt-8 text-sm font-semibold">For a more accurate scan next time</p>
              <Issues report={report} />
            </>
          )}

          <div className="mt-8 flex flex-wrap gap-3">
            {done && (
              <Button size="lg" onClick={() => router.push('/profile')}>
                See my Body Profile <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            {failed && (
              <ButtonLink
                size="lg"
                href={`/scan?retake=${(report?.views ?? []).filter((v) => !v.ok).map((v) => v.view).join(',')}`}
              >
                <RotateCcw className="h-4 w-4" /> Retake photos
              </ButtonLink>
            )}
            {(done || failed) && (
              <Link href="/shop" className="inline-flex items-center px-3 text-sm font-medium text-ink-muted hover:text-ink">
                Browse the shop
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Issues({ report }: { report: ScanReport }) {
  const byView = VIEWS.map((v) => ({
    view: v as View,
    issues: report.issues.filter((i) => i.view === v),
  })).filter((x) => x.issues.length > 0);

  return (
    <div className="mt-6 space-y-3">
      {byView.map(({ view, issues }) => (
        <Card key={view} className="p-4">
          <p className="mb-2 text-sm font-semibold">{VIEW_COPY[view].title} photo</p>
          <ul className="space-y-1.5">
            {issues.map((i) => (
              <li key={i.code} className="flex items-start gap-2 text-sm">
                <Badge tone={i.severity === 'error' ? 'warn' : 'neutral'} className="mt-0.5 shrink-0">
                  {i.severity === 'error' ? 'Fix' : 'Tip'}
                </Badge>
                <span className="text-ink-soft">{i.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export default function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  return <RequireUser>{() => <Progress jobId={jobId} />}</RequireUser>;
}
