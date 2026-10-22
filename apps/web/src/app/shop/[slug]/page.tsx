'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Info, Ruler, ScanLine, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fmtNumber, fmtPrice, titleCase, type Units } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { FitDimension, FitPreference, GarmentDetail, RecommendationView } from '@/lib/types';
import { GarmentArt } from '@/components/garment-art';
import { ScoreRing } from '@/components/score-ring';
import { Badge, Button, ButtonLink, Card, Segmented, Spinner, cx } from '@/components/ui';

const DIM_LABEL: Record<string, string> = {
  chest: 'Chest',
  waist: 'Waist',
  hip: 'Hip',
  shoulder_width: 'Shoulders',
  neck: 'Neck',
  arm_length: 'Sleeve',
  inseam: 'Inseam',
  thigh: 'Thigh',
};

export default function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { user } = useSession();
  const [g, setG] = useState<GarmentDetail | null>(null);
  // 404 → "no such item"; anything else (API down, network) is shown as-is.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rec, setRec] = useState<RecommendationView | null>(null);
  const [pref, setPref] = useState<FitPreference>('REGULAR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsScan, setNeedsScan] = useState(false);
  const [units, setUnits] = useState<Units>('cm');
  const [selectedSize, setSelectedSize] = useState<string | null>(null);

  useEffect(() => {
    api<GarmentDetail>(`/garments/${slug}`, { auth: false })
      .then(setG)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "We couldn't find that item."
            : (err as Error).message,
        ),
      );
  }, [slug]);

  useEffect(() => {
    if (user) setPref(user.fitPreference);
  }, [user]);

  // Show a previous recommendation for this item straight away.
  useEffect(() => {
    if (!user) return;
    api<RecommendationView[]>('/me/recommendations')
      .then((rs) => {
        const r = rs.find((x) => x.garment.slug === slug);
        if (r) {
          setRec(r);
          setPref(r.preference);
          setSelectedSize(r.recommendedSize);
        }
      })
      .catch(() => {});
  }, [user, slug]);

  async function findSize(preference: FitPreference) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RecommendationView>(`/garments/${slug}/recommend`, {
        method: 'POST',
        body: { preference },
      });
      setRec(r);
      setSelectedSize(r.recommendedSize);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNeedsScan(true);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="container-page py-20 text-center">
        <p className="text-ink-muted">{loadError}</p>
        <ButtonLink href="/shop" className="mt-6">
          Back to shop
        </ButtonLink>
      </div>
    );
  }
  if (!g) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="container-page py-8">
      <Link href="/shop" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Shop
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        {/* product — min-w-0 lets the size-chart table scroll inside its card
            instead of widening the grid column past a phone's screen */}
        <div className="min-w-0">
          <Card className="aspect-square overflow-hidden bg-gradient-to-b from-[#fbfaf6] to-[#efece4] p-12">
            <GarmentArt subcategory={g.subcategory} category={g.category} colorHex={g.colorHex} className="h-full w-full" />
          </Card>
          <Card className="mt-6 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-semibold">
                <Ruler className="h-4 w-4 text-ink-muted" /> Size chart
              </h2>
              <Segmented
                size="sm"
                value={units}
                onChange={setUnits}
                options={[
                  { value: 'cm', label: 'cm' },
                  { value: 'in', label: 'in' },
                ]}
              />
            </div>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                    <th className="py-2 pr-4 font-medium">Size</th>
                    {g.sizeChart.dimensions.map((d) => (
                      <th key={d} className="py-2 pr-4 font-medium">
                        {DIM_LABEL[d] ?? d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.sizeChart.sizes.map((s) => (
                    <tr
                      key={s.label}
                      className={cx(
                        'border-t border-line',
                        rec?.recommendedSize === s.label && 'bg-accent-soft/60 font-medium',
                      )}
                    >
                      <td className="py-2.5 pr-4 font-semibold">{s.label}</td>
                      {g.sizeChart.dimensions.map((d) => {
                        const rng = s.measurements[d];
                        return (
                          <td key={d} className="whitespace-nowrap py-2.5 pr-4 text-ink-soft">
                            {rng ? `${fmtNumber(rng[0], units, 0)}–${fmtNumber(rng[1], units, 0)}` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-muted">Body measurements, as published by {g.brand.name}.</p>
          </Card>
        </div>

        {/* details + fit */}
        <div className="min-w-0 lg:pt-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-muted">{g.brand.name}</p>
          <h1 className="mt-2 font-display text-5xl leading-tight">{g.name}</h1>
          <p className="mt-3 text-xl">{fmtPrice(g.priceCents, g.currency)}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge>{titleCase(g.fitIntent)} fit</Badge>
            <Badge>{g.stretch === 'NONE' ? 'No stretch' : `${titleCase(g.stretch)} stretch`}</Badge>
            <Badge>{g.colorName}</Badge>
          </div>
          <p className="mt-6 leading-relaxed text-ink-soft">{g.description}</p>
          <p className="mt-2 text-sm text-ink-muted">{g.material}</p>

          <Card className="mt-8 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Sparkles className="h-4 w-4 text-accent" /> Find my size
              </h2>
              <Segmented
                size="sm"
                value={pref}
                onChange={(p) => {
                  setPref(p);
                  if (rec) void findSize(p);
                }}
                options={[
                  { value: 'SNUG', label: 'Snug' },
                  { value: 'REGULAR', label: 'Regular' },
                  { value: 'LOOSE', label: 'Loose' },
                ]}
              />
            </div>

            {!user ? (
              <div className="mt-5">
                <p className="text-sm text-ink-muted">Sign in and scan once — we&apos;ll size you for every item.</p>
                <ButtonLink href={`/signin?next=/shop/${slug}`} className="mt-4">
                  Sign in to find my size
                </ButtonLink>
              </div>
            ) : needsScan ? (
              <div className="mt-5 flex items-start gap-4 rounded-xl bg-paper p-4">
                <ScanLine className="mt-0.5 h-5 w-5 text-accent" />
                <div>
                  <p className="font-medium">Scan your body first</p>
                  <p className="mt-1 text-sm text-ink-muted">Your size is worked out from your Body Profile. It takes two minutes.</p>
                  <ButtonLink href="/scan" size="sm" className="mt-3">
                    Start my scan
                  </ButtonLink>
                </div>
              </div>
            ) : !rec ? (
              <div className="mt-5">
                <Button variant="accent" size="lg" className="w-full" loading={busy} onClick={() => findSize(pref)}>
                  Find my size
                </Button>
                {error && <p className="mt-3 text-sm text-bad">{error}</p>}
              </div>
            ) : (
              <Result
                rec={rec}
                units={units}
                busy={busy}
                selectedSize={selectedSize}
                onSelectSize={setSelectedSize}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Result({
  rec,
  units,
  busy,
  selectedSize,
  onSelectSize,
}: {
  rec: RecommendationView;
  units: Units;
  busy: boolean;
  selectedSize: string | null;
  onSelectSize: (s: string) => void;
}) {
  const [feedback, setFeedback] = useState<string | null>(rec.feedback?.outcome ?? null);

  async function send(outcome: 'PERFECT' | 'TOO_SMALL' | 'TOO_LARGE') {
    setFeedback(outcome);
    await api(`/recommendations/${rec.id}/feedback`, {
      method: 'POST',
      body: { sizeChosen: selectedSize ?? rec.recommendedSize, outcome },
    }).catch(() => setFeedback(null));
  }

  return (
    <div className={cx('mt-6 animate-fade-up transition', busy && 'opacity-50')}>
      <div className="flex items-center gap-6">
        <ScoreRing score={rec.fitScore} />
        <div>
          <p className="text-sm text-ink-muted">Your size</p>
          <p className="font-display text-6xl leading-none">{rec.recommendedSize}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={rec.fitScore >= 70 ? 'good' : rec.fitScore >= 50 ? 'warn' : 'bad'}>{rec.fitLabel}</Badge>
            <Badge tone={rec.confidence.label === 'high' ? 'accent' : 'neutral'}>
              {titleCase(rec.confidence.label)} confidence
            </Badge>
            {rec.betweenSizes && rec.alternativeSize && <Badge tone="warn">Between sizes</Badge>}
          </div>
        </div>
      </div>

      <p className="mt-5 leading-relaxed text-ink-soft">{rec.explanation}</p>

      {/* every size, scored */}
      <div className="scroll-thin mt-5 flex gap-2 overflow-x-auto pb-1">
        {rec.sizes.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onSelectSize(s.label)}
            className={cx(
              'focus-ring flex min-w-[3.5rem] shrink-0 flex-col items-center rounded-xl border px-3 py-2 transition',
              s.label === rec.recommendedSize
                ? 'border-ink bg-ink text-paper'
                : selectedSize === s.label
                  ? 'border-ink-faint bg-white'
                  : 'border-line bg-white text-ink-soft hover:border-ink-faint',
            )}
          >
            <span className="text-sm font-semibold">{s.label}</span>
            <span className={cx('text-[11px]', s.label === rec.recommendedSize ? 'text-paper/70' : 'text-ink-muted')}>
              {s.score}
            </span>
          </button>
        ))}
      </div>

      {/* how each dimension fits */}
      <div className="mt-6 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          How {rec.recommendedSize} fits you
        </p>
        {rec.dimensions.map((d) => (
          <DimensionBar key={d.name} d={d} units={units} />
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5 text-sm">
        {feedback ? (
          <span className="inline-flex items-center gap-1.5 text-good">
            <Check className="h-4 w-4" /> Thanks — your feedback trains better fits.
          </span>
        ) : (
          <>
            <span className="mr-1 text-ink-muted">Bought it? How did it fit?</span>
            <FbBtn onClick={() => send('TOO_SMALL')}>
              <ThumbsDown className="h-3.5 w-3.5" /> Too small
            </FbBtn>
            <FbBtn onClick={() => send('PERFECT')}>
              <ThumbsUp className="h-3.5 w-3.5" /> Perfect
            </FbBtn>
            <FbBtn onClick={() => send('TOO_LARGE')}>
              <ThumbsDown className="h-3.5 w-3.5" /> Too large
            </FbBtn>
          </>
        )}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
        <Info className="mt-0.5 h-3 w-3 shrink-0" /> Rules-based fit engine ({rec.engineVersion}). Scores compare your
        measurements with the brand&apos;s chart, adjusted for cut, stretch and your preference.
      </p>
    </div>
  );
}

function DimensionBar({ d, units }: { d: FitDimension; units: Units }) {
  const [lo, hi] = d.range;
  const span = hi - lo;
  // Show the size's range in the middle 50% of the track, with room either side.
  const min = lo - span;
  const max = hi + span;
  const pos = Math.min(1, Math.max(0, (d.body - min) / (max - min)));
  const good = d.verdict === 'good fit' || d.verdict === 'good length';
  const tight = d.verdict.includes('tight') || d.verdict.includes('short');
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">{d.label}</span>
        <span className={cx('text-xs font-medium', good ? 'text-good' : tight ? 'text-bad' : 'text-warn')}>
          {titleCase(d.verdict)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-black/[0.06]">
        <div className="absolute inset-y-0 left-1/4 right-1/4 rounded-full bg-accent/25" />
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-ink shadow-soft transition-all duration-500"
          style={{ left: `${pos * 100}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-muted">
        <span>
          You: {fmtNumber(d.body, units)} {units}
        </span>
        <span>
          Size range {fmtNumber(lo, units, 0)}–{fmtNumber(hi, units, 0)} {units}
        </span>
      </div>
    </div>
  );
}

function FbBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-soft transition hover:border-ink-faint hover:text-ink"
    >
      {children}
    </button>
  );
}
