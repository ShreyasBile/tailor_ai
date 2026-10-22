'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight, Info, RotateCcw, ScanLine, Shirt } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { confidenceTone, confidenceWord, fmtNumber, relativeDate, type Units } from '@/lib/format';
import type { AvatarRender, BodyCore, MeasurementDetail, MeasurementsResponse, RecommendationView, UserProfile } from '@/lib/types';
import { RequireUser } from '@/components/guard';
import { GarmentArt } from '@/components/garment-art';
import { Badge, ButtonLink, Card, ConfidenceMeter, EmptyState, Segmented, Spinner, cx } from '@/components/ui';
import type { Highlight } from '@/components/body-viewer';

// three.js only runs in the browser.
const BodyViewer = dynamic(() => import('@/components/body-viewer').then((m) => m.BodyViewer), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  ),
});

interface ProfileData {
  meas: MeasurementsResponse;
  avatar: AvatarRender | null;
  history: BodyCore[];
  recs: RecommendationView[];
}

function Profile({ user }: { user: UserProfile }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<Units>('cm');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [meas, avatar, history, recs] = await Promise.all([
          api<MeasurementsResponse>('/me/measurements'),
          api<AvatarRender>('/me/avatar').catch(() => null),
          api<BodyCore[]>('/me/body-core/history').catch(() => []),
          api<RecommendationView[]>('/me/recommendations').catch(() => []),
        ]);
        setData({ meas, avatar, history, recs });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError((err as Error).message);
      }
    })();
  }, []);

  const details: MeasurementDetail[] = useMemo(() => data?.meas.details ?? [], [data]);
  const selectedDetail = details.find((d) => d.name === selected) ?? null;
  const highlight: Highlight | null = selectedDetail
    ? {
        ...(selectedDetail.region as Omit<Highlight, 'label' | 'value'>),
        kind: selectedDetail.kind,
        label: selectedDetail.label,
        value: `${fmtNumber(selectedDetail.value, units)} ${units}`,
      }
    : null;

  if (missing) {
    return (
      <div className="container-page py-10">
        <Card>
          <EmptyState
            icon={<ScanLine className="h-6 w-6" />}
            title="No Body Profile yet"
            body="Take four photos and we'll build a 3D model of your body and measure it — about two minutes."
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
  if (error) return <p className="container-page py-20 text-center text-bad">{error}</p>;
  if (!data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const { meas, avatar, history, recs } = data;
  const current = history.find((c) => c.isCurrent) ?? history[0];
  const conf = meas.confidence ?? 0;
  const heightM = (meas.heightCm ?? user.heightCm ?? 175) / 100;

  return (
    <div className="container-page py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow mb-3">Body Profile{current ? ` · v${current.version}` : ''}</p>
          <h1 className="font-display text-5xl">{user.displayName ? `${user.displayName}'s body` : 'Your body'}</h1>
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            size="sm"
            value={units}
            onChange={setUnits}
            options={[
              { value: 'cm', label: 'cm' },
              { value: 'in', label: 'in' },
            ]}
          />
          <ButtonLink href="/scan" variant="secondary" size="sm">
            <RotateCcw className="h-3.5 w-3.5" /> Rescan
          </ButtonLink>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* 3D model */}
        <Card className="relative h-[520px] overflow-hidden p-0 lg:sticky lg:top-24 lg:h-[640px]">
          {avatar?.assets.glb ? (
            <BodyViewer url={avatar.assets.glb.url} heightM={heightM} highlight={highlight} />
          ) : (
            <div className="grid h-full place-items-center text-sm text-ink-muted">3D model unavailable</div>
          )}
          <div className="absolute left-4 top-4 flex flex-wrap gap-1.5">
            <Badge tone="accent">{meas.heightCm ? `${fmtNumber(meas.heightCm, units, 0)} ${units} tall` : 'Height unknown'}</Badge>
            {selectedDetail && <Badge>{selectedDetail.label}</Badge>}
          </div>
        </Card>

        <div className="space-y-6">
          {/* summary */}
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-ink-muted">Measurement confidence</p>
                <div className="mt-1 flex items-center gap-3">
                  <span className="font-display text-4xl">{confidenceWord(conf)}</span>
                  <ConfidenceMeter value={conf} />
                </div>
              </div>
              <div className="text-right text-sm text-ink-muted">
                <p>{details.length} measurements</p>
                {current && <p>Scanned {relativeDate(current.createdAt)}</p>}
              </div>
            </div>
            <p className="mt-4 flex gap-2 rounded-xl bg-paper px-4 py-3 text-xs leading-relaxed text-ink-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Estimated from four photos, scaled by your height. &ldquo;±&rdquo; is the typical error we&apos;ve
              measured against tape-measured people; select a measurement to see where it was taken.
            </p>
          </Card>

          {/* measurements */}
          <div className="grid gap-3 sm:grid-cols-2">
            {details.map((d) => (
              <button
                key={d.name}
                type="button"
                onClick={() => setSelected((s) => (s === d.name ? null : d.name))}
                className={cx(
                  'focus-ring group rounded-xl2 border bg-card p-4 text-left shadow-soft transition',
                  selected === d.name ? 'border-accent ring-4 ring-accent/10' : 'border-line hover:border-ink-faint',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-ink-soft">{d.label}</span>
                  <Badge tone={d.name === 'height' ? 'accent' : confidenceTone(d.confidence)}>
                    {d.name === 'height' ? 'Provided' : confidenceWord(d.confidence)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-display text-4xl leading-none">{fmtNumber(d.value, units)}</span>
                  <span className="text-sm text-ink-muted">{units}</span>
                  {d.typicalErrorCm != null && d.name !== 'height' && (
                    <span className="ml-auto text-xs text-ink-muted">± {fmtNumber(d.typicalErrorCm, units)}</span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-ink-faint" title={d.method}>
                    {d.kind === 'girth' ? 'Circumference' : d.kind === 'width' ? 'Width' : 'Length'}
                  </span>
                  {d.name !== 'height' && <ConfidenceMeter value={d.confidence} />}
                </div>
              </button>
            ))}
          </div>

          {/* recommendations */}
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Your sizes</h2>
              <Link href="/shop" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                Find more <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {recs.length === 0 ? (
              <div className="flex items-center gap-4 rounded-xl bg-paper p-4">
                <Shirt className="h-5 w-5 text-ink-muted" />
                <p className="text-sm text-ink-muted">
                  Open any item in the shop and tap <strong className="text-ink">Find my size</strong>.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {recs.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <Link href={`/shop/${r.garment.slug}`} className="flex items-center gap-4 py-3 transition hover:opacity-80">
                      <div className="h-14 w-14 shrink-0 rounded-xl bg-paper p-1">
                        <GarmentArt
                          subcategory={r.garment.subcategory}
                          category={r.garment.category}
                          colorHex={r.garment.colorHex}
                          className="h-full w-full"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{r.garment.name}</p>
                        <p className="text-xs text-ink-muted">{r.garment.brand.name}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-display text-2xl leading-none">{r.recommendedSize}</p>
                        <p className="text-xs text-ink-muted">{r.fitScore} fit</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* history */}
          {history.length > 0 && (
            <Card className="p-6">
              <h2 className="mb-4 font-semibold">Scan history</h2>
              <ul className="space-y-2">
                {history.map((c) => (
                  <li key={c.id} className="flex items-center justify-between rounded-xl bg-paper px-4 py-3 text-sm">
                    <span className="font-medium">Version {c.version}</span>
                    <span className="text-ink-muted">{new Date(c.createdAt).toLocaleDateString()}</span>
                    {c.isCurrent ? <Badge tone="accent">Current</Badge> : <Badge>Previous</Badge>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return <RequireUser>{(user) => <Profile user={user} />}</RequireUser>;
}
