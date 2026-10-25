'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Info, Ruler, ScanLine, Users, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import type { AccuracyReport, MeasurementsResponse, TapeCheckView, UserProfile } from '@/lib/types';
import { RequireUser } from '@/components/guard';
import { Badge, Button, ButtonLink, Card, EmptyState, Spinner, cx, inputClass } from '@/components/ui';

/** How to take each measurement with a tape — matches how the scan measures. */
const GUIDE: { name: string; label: string; how: string }[] = [
  { name: 'chest', label: 'Chest', how: 'Around the fullest part of the chest, under the armpits, tape level, breathing normally.' },
  { name: 'waist', label: 'Waist', how: 'Around the natural waist — the narrowest point, usually just above the navel. Relax, don’t pull in.' },
  { name: 'hip', label: 'Hip', how: 'Around the widest part of the seat, feet together.' },
  { name: 'neck', label: 'Neck', how: 'Around the base of the neck, where a shirt collar sits. One finger under the tape.' },
  { name: 'shoulder_width', label: 'Shoulder width', how: 'Straight across the back, from one shoulder tip (bony point) to the other.' },
  { name: 'arm_length', label: 'Arm length', how: 'Shoulder tip → elbow → wrist bone, arm slightly bent at your side.' },
  { name: 'inseam', label: 'Inseam', how: 'Crotch to the floor along the inside of the leg, standing barefoot.' },
  { name: 'thigh', label: 'Thigh', how: 'Around the top of one thigh, just below the crotch.' },
  { name: 'calf', label: 'Calf', how: 'Around the widest part of one calf.' },
  { name: 'torso_length', label: 'Torso length', how: 'From the top of the shoulder next to the neck down to the crotch (a friend helps).' },
];

function Accuracy({ user }: { user: UserProfile }) {
  const [meas, setMeas] = useState<MeasurementsResponse | null>(null);
  const [checks, setChecks] = useState<TapeCheckView[] | null>(null);
  const [report, setReport] = useState<AccuracyReport | null>(null);
  const [noScan, setNoScan] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [m, c, r] = await Promise.all([
        api<MeasurementsResponse>('/me/measurements'),
        api<TapeCheckView[]>('/me/tape-checks'),
        api<AccuracyReport>('/accuracy/report'),
      ]);
      setMeas(m);
      setChecks(c);
      setReport(r);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNoScan(true);
      else setError((err as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function submit() {
    const parsed = Object.fromEntries(
      Object.entries(values)
        .map(([k, v]) => [k, parseFloat(v.replace(',', '.'))] as const)
        .filter(([, v]) => Number.isFinite(v) && v > 0),
    );
    if (Object.keys(parsed).length === 0) {
      setError('Enter at least one measurement.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<TapeCheckView>('/me/tape-checks', { method: 'POST', body: { values: parsed, note: note || undefined } });
      setValues({});
      setNote('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (noScan) {
    return (
      <div className="container-page py-10">
        <Card>
          <EmptyState
            icon={<ScanLine className="h-6 w-6" />}
            title="Scan yourself first"
            body="The accuracy check compares your scan with a tape measure. Take your four photos, then come back with a tape."
            action={
              <ButtonLink href="/scan" size="lg">
                Start my scan <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            }
          />
        </Card>
      </div>
    );
  }
  if (!meas || !checks) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {error ? <p className="text-bad">{error}</p> : <Spinner className="h-6 w-6" />}
      </div>
    );
  }

  const scanned = new Map((meas.details ?? []).map((d) => [d.name, d]));
  const latest = checks[0];

  return (
    <div className="container-page py-10">
      <p className="eyebrow mb-3">Accuracy check</p>
      <h1 className="font-display text-5xl">Is my scan right?</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Measure yourself with a tape (a friend makes it easier), enter the numbers, and see how close your scan came.
        {user.displayName ? ` ${user.displayName}, every` : ' Every'} check also improves the accuracy report below.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {/* tape entry */}
        <Card className="p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Ruler className="h-4 w-4 text-accent" /> Your tape measurements (cm)
          </h2>
          <p className="mt-1 text-sm text-ink-muted">Fill in the ones you can — skip any you can’t measure well.</p>
          <div className="mt-5 space-y-4">
            {GUIDE.filter((g) => scanned.has(g.name)).map((g) => (
              <div key={g.name} className="grid gap-3 sm:grid-cols-[1fr_8rem] sm:items-center">
                <div>
                  <p className="text-sm font-medium">{g.label}</p>
                  <p className="text-xs text-ink-muted">{g.how}</p>
                </div>
                <input
                  className={inputClass}
                  inputMode="decimal"
                  // Never show the scan's value here: it would anchor the tape
                  // reading and bias the accuracy study.
                  placeholder="cm"
                  value={values[g.name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [g.name]: e.target.value }))}
                  aria-label={`${g.label} tape measurement in centimetres`}
                />
              </div>
            ))}
            <input
              className={inputClass}
              placeholder="Note (optional) — e.g. measured by Priya, morning"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
          <Button variant="accent" size="lg" className="mt-5 w-full" loading={busy} onClick={submit}>
            Compare with my scan
          </Button>
        </Card>

        {/* latest comparison */}
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Scan vs tape</h2>
            {!latest ? (
              <p className="mt-2 text-sm text-ink-muted">Your comparison appears here after you submit.</p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge tone={(latest.withinTargetPct ?? 0) >= 70 ? 'good' : 'warn'}>
                    {latest.withinTargetPct}% within target
                  </Badge>
                  <Badge>Average error {latest.meanAbsErrorCm} cm</Badge>
                  <Badge>Body v{latest.bodyVersion}</Badge>
                </div>
                <table className="mt-4 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                      <th className="py-1.5 font-medium">Measurement</th>
                      <th className="py-1.5 font-medium">Scan</th>
                      <th className="py-1.5 font-medium">Tape</th>
                      <th className="py-1.5 font-medium">Diff</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {latest.rows.map((r) => (
                      <tr key={r.name} className="border-t border-line">
                        <td className="py-2">{r.label}</td>
                        <td className="py-2 text-ink-soft">{r.scanCm}</td>
                        <td className="py-2 text-ink-soft">{r.tapeCm}</td>
                        <td className={cx('py-2 font-medium', r.withinTarget ? 'text-good' : 'text-bad')}>
                          {r.errorCm > 0 ? '+' : ''}
                          {r.errorCm}
                        </td>
                        <td className="py-2">
                          {r.withinTarget ? (
                            <Check className="h-4 w-4 text-good" aria-label={`within ±${r.targetCm} cm`} />
                          ) : (
                            <X className="h-4 w-4 text-bad" aria-label={`outside ±${r.targetCm} cm`} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" /> Diff = scan − tape. Target: ±3 cm on girths, ±2 cm on lengths
                  — about how much two people with a tape disagree. Checked {relativeDate(latest.createdAt)}.
                </p>
                {latest.rows.some((r) => !r.withinTarget) && (
                  <p className="mt-3 text-xs text-ink-muted">
                    Big differences? Rescan in tighter clothes, check your height is exact, and stand in the A-pose with
                    arms away from your body.
                  </p>
                )}
              </>
            )}
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-semibold">The wardrobe test</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Is the <em>size</em> right? Open an item like one you own that fits well, press <b>Find my size</b>, and
              compare with the size you actually wear. Then tell us with <b>Perfect / Too small / Too large</b>.
            </p>
            <ButtonLink href="/shop" variant="secondary" size="sm" className="mt-4">
              Go to the shop
            </ButtonLink>
          </Card>
        </div>
      </div>

      {/* group report */}
      {report && (
        <Card className="mt-6 p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-4 w-4 text-accent" /> Accuracy report — everyone who has checked
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {report.people} {report.people === 1 ? 'person' : 'people'}, {report.checks} checks (latest per person).
            {report.sizeFeedback.total > 0 &&
              ` Size feedback: ${report.sizeFeedback.perfectPct}% “perfect” of ${report.sizeFeedback.total}.`}
          </p>
          {report.rows.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">No checks yet — yours will be the first.</p>
          ) : (
            <div className="scroll-thin mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                    <th className="py-1.5 pr-4 font-medium">Measurement</th>
                    <th className="py-1.5 pr-4 font-medium">People</th>
                    <th className="py-1.5 pr-4 font-medium">Avg error</th>
                    <th className="py-1.5 pr-4 font-medium">Bias</th>
                    <th className="py-1.5 pr-4 font-medium">≤ 2 cm</th>
                    <th className="py-1.5 pr-4 font-medium">≤ 4 cm</th>
                    <th className="py-1.5 pr-4 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.name} className="border-t border-line">
                      <td className="py-2 pr-4">{r.label}</td>
                      <td className="py-2 pr-4 text-ink-soft">{r.n}</td>
                      <td className={cx('py-2 pr-4 font-medium', r.maeCm <= r.targetCm ? 'text-good' : 'text-bad')}>
                        {r.maeCm} cm
                      </td>
                      <td className="py-2 pr-4 text-ink-soft">
                        {r.biasCm > 0 ? '+' : ''}
                        {r.biasCm} cm
                      </td>
                      <td className="py-2 pr-4 text-ink-soft">{r.within2Pct}%</td>
                      <td className="py-2 pr-4 text-ink-soft">{r.within4Pct}%</td>
                      <td className="py-2 pr-4 text-ink-soft">±{r.targetCm} cm</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-faint">
            Bias = average of scan − tape: a steady + means the scan reads large and can be corrected.{' '}
            <Link href="/profile" className="underline">
              Your Body Profile
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}

export default function AccuracyPage() {
  return <RequireUser>{(user) => <Accuracy user={user} />}</RequireUser>;
}
