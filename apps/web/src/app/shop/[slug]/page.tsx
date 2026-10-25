'use client';

import { use, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowLeft, Check, Info, Ruler, ScanLine, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fmtNumber, fmtPrice, titleCase, type Units } from '@/lib/format';
import { useSession } from '@/lib/session';
import type {
  AvatarRender,
  FitDimension,
  FitPreference,
  GarmentDetail,
  GeneratedImage,
  MeasurementsResponse,
  RecommendationView,
} from '@/lib/types';
import { ProductImage, garmentKind } from '@/components/garment-art';
import { ScoreRing } from '@/components/score-ring';
import { Badge, Button, ButtonLink, Card, Segmented, Spinner, cx } from '@/components/ui';
import { DEFAULT_LANDMARKS, FIT_COLORS, type Landmarks } from '@/lib/tryon';
import type { TryOnMode } from '@/components/tryon-viewer';

// three.js only runs in the browser.
const TryOnViewer = dynamic(() => import('@/components/tryon-viewer').then((m) => m.TryOnViewer), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  ),
});

/** Measurement heights from the scan (fractions of stature), for placing the
 * garment's chest, waist and hip on this particular body. */
function landmarksFrom(meas: MeasurementsResponse | null): Landmarks {
  const l = { ...DEFAULT_LANDMARKS };
  for (const d of meas?.details ?? []) {
    const r = d.region as { y?: number; y0?: number; y1?: number };
    if (d.name === 'chest' && r.y) l.chest = r.y;
    if (d.name === 'waist' && r.y) l.waist = r.y;
    if (d.name === 'hip' && r.y) l.hip = r.y;
    if (d.name === 'neck' && r.y) l.neck = r.y;
    if (d.name === 'thigh' && r.y) l.thigh = r.y;
    if (d.name === 'shoulder_width' && r.y) l.shoulder = r.y;
    if (d.name === 'inseam' && r.y1) l.crotch = r.y1;
  }
  return l;
}

/** The fit detail for one size; older stored recommendations only carry the
 * recommended size's. */
function dimsForSize(rec: RecommendationView, size: string | null): FitDimension[] | null {
  const label = size ?? rec.recommendedSize;
  const s = rec.sizes.find((x) => x.label === label);
  if (s?.dimensions) return s.dimensions;
  return label === rec.recommendedSize ? rec.dimensions : null;
}

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
  const [avatar, setAvatar] = useState<AvatarRender | null>(null);
  const [meas, setMeas] = useState<MeasurementsResponse | null>(null);
  const [view, setView] = useState<'product' | 'tryon' | 'photo'>('product');
  const [mode, setMode] = useState<TryOnMode>('fit');

  // The body to try clothes on.
  useEffect(() => {
    if (!user) return;
    api<AvatarRender>('/me/avatar').then(setAvatar).catch(() => setAvatar(null));
    api<MeasurementsResponse>('/me/measurements').then(setMeas).catch(() => setMeas(null));
  }, [user]);

  const landmarks = useMemo(() => landmarksFrom(meas), [meas]);
  const tryDims = useMemo(() => (rec ? dimsForSize(rec, selectedSize) : null), [rec, selectedSize]);
  const canTryOn = Boolean(avatar?.assets.glb && rec && tryDims);
  useEffect(() => {
    if (canTryOn) setView('tryon');
  }, [canTryOn]);

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
          {(canTryOn || (user && g.imageUrl)) && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  ...(canTryOn ? [{ value: 'tryon' as const, label: 'Fit on my body' }] : []),
                  ...(user && g.imageUrl ? [{ value: 'photo' as const, label: 'Photo try-on' }] : []),
                  { value: 'product' as const, label: 'Product' },
                ]}
              />
              {view === 'tryon' && (
                <Segmented
                  size="sm"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'fit', label: 'Fit map' },
                    { value: 'fabric', label: 'Fabric' },
                  ]}
                />
              )}
            </div>
          )}
          {view === 'tryon' && canTryOn && avatar?.assets.glb && rec && tryDims ? (
            <Card className="relative aspect-square overflow-hidden p-0">
              <TryOnViewer
                url={avatar.assets.glb.url}
                heightM={(meas?.heightCm ?? user?.heightCm ?? 175) / 100}
                kind={garmentKind(g.subcategory, g.category)}
                category={g.category}
                fitIntent={g.fitIntent}
                colorHex={g.colorHex}
                dims={tryDims}
                landmarks={landmarks}
                armLengthCm={meas?.details?.find((d) => d.name === 'arm_length')?.value}
                inseamCm={meas?.details?.find((d) => d.name === 'inseam')?.value}
                mode={mode}
                units={units}
              />
              <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-1.5">
                <Badge tone="accent">Size {selectedSize ?? rec.recommendedSize}</Badge>
              </div>
              {mode === 'fit' && <FitLegend />}
            </Card>
          ) : view === 'photo' && user && g.imageUrl ? (
            <PhotoTryOn slug={g.slug} garmentName={g.name} imageUrl={g.imageUrl} />
          ) : (
            <Card className={cx('aspect-square overflow-hidden bg-gradient-to-b from-[#fbfaf6] to-[#efece4]', !g.imageUrl && 'p-12')}>
              <ProductImage
                imageUrl={g.imageUrl}
                name={g.name}
                subcategory={g.subcategory}
                category={g.category}
                colorHex={g.colorHex}
                className="h-full w-full"
              />
            </Card>
          )}
          {view === 'tryon' && canTryOn && (
            <p className="mt-2 text-xs text-ink-muted">
              Your scanned body wearing size {selectedSize ?? rec?.recommendedSize}. Pick another size on the right to
              compare. Colours show how each zone compares with this size; grey means the scan wasn&apos;t sure of that
              measurement — rescan in fitted clothes.
            </p>
          )}
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
            {rec.noSizeFits && <Badge tone="bad">No size fits</Badge>}
          </div>
        </div>
      </div>

      <p className="mt-5 leading-relaxed text-ink-soft">{rec.explanation}</p>
      {rec.explanationSource.startsWith('gemini') && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-faint">
          <Sparkles className="h-3 w-3" /> Written with Gemini from the numbers below — sizes come from the fit engine.
        </p>
      )}

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
            <span className={cx('text-sm font-semibold', s.blocked && s.label !== rec.recommendedSize && 'text-ink-faint line-through')}>
              {s.label}
            </span>
            <span className={cx('text-[11px]', s.label === rec.recommendedSize ? 'text-paper/70' : s.blocked ? 'text-bad' : 'text-ink-muted')}>
              {s.blocked && s.label !== rec.recommendedSize ? 'too small' : s.score}
            </span>
          </button>
        ))}
      </div>

      {/* how each dimension fits — for whichever size is selected */}
      <div className="mt-6 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          How {selectedSize ?? rec.recommendedSize} fits you
        </p>
        {(dimsForSize(rec, selectedSize) ?? rec.dimensions).map((d) => (
          <DimensionBar key={d.name} d={d} units={units} />
        ))}
        {!dimsForSize(rec, selectedSize) && (
          <p className="text-xs text-ink-muted">Press “Find my size” again to see every size in detail.</p>
        )}
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

/**
 * The shopper's own scan photo wearing this item, made by Gemini on request.
 * Asks first: the photo leaves this app. The result is shown, never stored.
 */
function PhotoTryOn({ slug, garmentName, imageUrl }: { slug: string; garmentName: string; imageUrl: string }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setImage(await api<GeneratedImage>(`/garments/${slug}/photo-tryon`, { method: 'POST', body: { consent: true } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (image) {
    return (
      <Card className="overflow-hidden p-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:${image.mimeType};base64,${image.imageBase64}`} alt={`You wearing the ${garmentName}`} className="w-full" />
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
            <Info className="mt-0.5 h-3 w-3 shrink-0" /> AI-generated preview ({image.model}) for style only — it always
            makes clothes look good. Your size and fit come from the fit map. Not saved.
          </p>
          <Button variant="secondary" size="sm" loading={busy} onClick={run}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <div className="flex gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={garmentName} className="h-28 w-28 shrink-0 rounded-xl object-cover" />
        <div>
          <h3 className="font-semibold">See yourself in it</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Gemini puts this {garmentName} on the front photo from your scan — your face, body and background stay the
            same. Takes about 20 seconds.
          </p>
        </div>
      </div>
      <label className="mt-5 flex items-start gap-2.5 rounded-xl bg-paper p-3 text-sm">
        <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span className="text-ink-soft">
          I agree to send my front scan photo to Google Gemini to make this image. It is used once, shown here, and not
          stored by TailorAI.
        </span>
      </label>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Button variant="accent" size="lg" className="mt-4 w-full" disabled={!agreed} loading={busy} onClick={run}>
        <Sparkles className="h-4 w-4" /> Create my try-on photo
      </Button>
    </Card>
  );
}

function FitLegend() {
  const items: [string, string][] = [
    [FIT_COLORS.tight, 'Too tight'],
    [FIT_COLORS.snug, 'Snug'],
    [FIT_COLORS.good, 'Good'],
    [FIT_COLORS.loose, 'Loose'],
    [FIT_COLORS.unsure, 'Unsure measurement'],
  ];
  return (
    <div className="pointer-events-none absolute bottom-14 left-4 flex flex-col gap-1 rounded-xl border border-line bg-white/90 px-3 py-2 text-[11px] shadow-soft">
      {items.map(([c, label]) => (
        <span key={label} className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} /> {label}
        </span>
      ))}
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
