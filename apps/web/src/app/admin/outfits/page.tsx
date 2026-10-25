'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ImageUp, Plus, Ruler, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtPrice } from '@/lib/format';
import type { AdminStatus, CreateGarmentRequest, ReadSizeChartResponse, UserProfile } from '@/lib/types';
import { RequireUser } from '@/components/guard';
import { GarmentArt } from '@/components/garment-art';
import { Badge, Button, Card, EmptyState, Field, Segmented, Spinner, cx, inputClass } from '@/components/ui';

const DIMS: { key: string; label: string }[] = [
  { key: 'chest', label: 'Chest' },
  { key: 'waist', label: 'Waist' },
  { key: 'hip', label: 'Hip' },
  { key: 'shoulder_width', label: 'Shoulders' },
  { key: 'neck', label: 'Neck' },
  { key: 'arm_length', label: 'Arm (shoulder→wrist)' },
  { key: 'inseam', label: 'Inseam' },
  { key: 'thigh', label: 'Thigh' },
];
/** Dimensions the fit engine weighs for each category — the defaults to fill. */
const CATEGORY_DIMS: Record<string, string[]> = {
  TOPS: ['chest', 'waist', 'shoulder_width'],
  OUTERWEAR: ['chest', 'waist', 'shoulder_width', 'arm_length'],
  BOTTOMS: ['waist', 'hip', 'inseam'],
  DRESSES: ['chest', 'waist', 'hip'],
};
const SUBCATEGORIES = [
  'T-shirts', 'Polos', 'Shirts', 'Knitwear', 'Hoodies', 'Kurtas', 'Blazers', 'Jackets', 'Nehru Jackets',
  'Coats', 'Jeans', 'Trousers', 'Joggers', 'Leggings', 'Shorts', 'Skirts', 'Dresses',
];

interface Row {
  label: string;
  cells: Record<string, { min: string; max: string }>;
}
interface BrandOpt {
  slug: string;
  name: string;
}

/** Downscale to ≤1600 px JPEG and return base64 (no data: prefix). */
async function chartImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const s = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * s);
  canvas.height = Math.round(bitmap.height * s);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1]!;
}

function AddOutfit({ user }: { user: UserProfile }) {
  const router = useRouter();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [brands, setBrands] = useState<BrandOpt[]>([]);

  // size chart
  const [dims, setDims] = useState<string[]>(CATEGORY_DIMS.TOPS!);
  const [rows, setRows] = useState<Row[]>([{ label: 'S', cells: {} }, { label: 'M', cells: {} }, { label: 'L', cells: {} }]);
  const [reading, setReading] = useState(false);
  const [readInfo, setReadInfo] = useState<ReadSizeChartResponse | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // details
  const [brandMode, setBrandMode] = useState<'existing' | 'new'>('existing');
  const [brandSlug, setBrandSlug] = useState('');
  const [brandName, setBrandName] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<CreateGarmentRequest['category']>('TOPS');
  const [subcategory, setSubcategory] = useState('T-shirts');
  const [gender, setGender] = useState<CreateGarmentRequest['gender']>('unisex');
  const [fitIntent, setFitIntent] = useState<CreateGarmentRequest['fitIntent']>('REGULAR');
  const [stretch, setStretch] = useState<CreateGarmentRequest['stretch']>('NONE');
  const [material, setMaterial] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [colorName, setColorName] = useState('');
  const [colorHex, setColorHex] = useState('#3a5a8c');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AdminStatus>('/admin/status').then(setStatus).catch(() => setStatus({ isAdmin: false, geminiEnabled: false }));
    api<BrandOpt[]>('/brands', { auth: false })
      .then((b) => {
        setBrands(b);
        if (b[0]) setBrandSlug(b[0].slug);
      })
      .catch(() => {});
  }, []);

  async function readChart(file: File) {
    setReading(true);
    setError(null);
    setPreview(URL.createObjectURL(file));
    try {
      const imageBase64 = await chartImage(file);
      const res = await api<ReadSizeChartResponse>('/admin/size-chart/read', {
        method: 'POST',
        body: { imageBase64, mimeType: 'image/jpeg' },
      });
      setReadInfo(res);
      if (res.dimensions.length) setDims(res.dimensions);
      setRows(
        res.sizes.map((s) => ({
          label: s.label,
          cells: Object.fromEntries(
            Object.entries(s.measurements).map(([d, [lo, hi]]) => [d, { min: String(lo), max: String(hi) }]),
          ),
        })),
      );
      if (res.categoryGuess) setCategory(res.categoryGuess);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(false);
    }
  }

  const setCell = (r: number, d: string, k: 'min' | 'max', v: string) =>
    setRows((rs) =>
      rs.map((row, i) => {
        if (i !== r) return row;
        const cell = row.cells[d] ?? { min: '', max: '' };
        return { ...row, cells: { ...row.cells, [d]: { ...cell, [k]: v } } };
      }),
    );

  const sizes = useMemo(
    () =>
      rows
        .filter((r) => r.label.trim())
        .map((r) => ({
          label: r.label.trim(),
          measurements: Object.fromEntries(
            dims
              .map((d) => [d, [parseFloat(r.cells[d]?.min ?? ''), parseFloat(r.cells[d]?.max ?? '')]] as const)
              .filter(([, [lo, hi]]) => Number.isFinite(lo) && Number.isFinite(hi) && lo < hi),
          ) as Record<string, [number, number]>,
        })),
    [rows, dims],
  );

  async function save() {
    setError(null);
    const priceCents = Math.round(parseFloat(price) * 100);
    if (!name.trim() || !material.trim() || description.trim().length < 10 || !colorName.trim() || !(priceCents > 0)) {
      setError('Fill in name, material, colour, price and a description (10+ characters).');
      return;
    }
    if (!sizes.some((s) => Object.keys(s.measurements).length > 0)) {
      setError('Add at least one size with a min and max measurement.');
      return;
    }
    const body: CreateGarmentRequest = {
      brand: brandMode === 'existing' ? { slug: brandSlug } : { name: brandName.trim(), accentHex: colorHex },
      name: name.trim(),
      category,
      subcategory: subcategory.trim(),
      gender,
      fitIntent,
      stretch,
      material: material.trim(),
      description: description.trim(),
      priceCents,
      currency,
      colorName: colorName.trim(),
      colorHex,
      sizeChart: { sizes: sizes.filter((s) => Object.keys(s.measurements).length > 0) },
    };
    setSaving(true);
    try {
      const { slug } = await api<{ slug: string }>('/admin/garments', { method: 'POST', body });
      router.push(`/shop/${slug}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  if (!status) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!status.isAdmin) {
    return (
      <div className="container-page py-10">
        <Card>
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" />}
            title="Admins only"
            body={`${user.email ?? 'This account'} can't add outfits. Ask for your email to be added to ADMIN_EMAILS.`}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="container-page py-10">
      <p className="eyebrow mb-3">Catalogue</p>
      <h1 className="font-display text-5xl">Add an outfit</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Photograph or screenshot the brand’s size chart and Gemini fills in the table — check it, add the details,
        and the outfit appears in the shop with Find my size and Try it on.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-6">
          {/* 1 · size chart */}
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Ruler className="h-4 w-4 text-accent" /> 1 · Size chart (body measurements, cm)
              </h2>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readChart(f);
                  e.target.value = '';
                }}
              />
              <Button
                variant="accent"
                size="sm"
                loading={reading}
                disabled={!status.geminiEnabled}
                onClick={() => fileRef.current?.click()}
              >
                <ImageUp className="h-4 w-4" /> Read a chart image
              </Button>
            </div>
            {!status.geminiEnabled && (
              <p className="mt-2 text-xs text-ink-muted">Set GEMINI_API_KEY to read charts from images — or type them below.</p>
            )}
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Uploaded size chart" className="mt-4 max-h-56 rounded-lg border border-line object-contain" />
            )}
            {readInfo && (
              <div className="mt-4 space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Sparkles className="h-3.5 w-3.5 text-accent" /> Read by {readInfo.model} · {readInfo.sizes.length} sizes ·{' '}
                  {readInfo.chartKind} chart — check every number before saving.
                </p>
                {readInfo.warnings.map((w) => (
                  <p key={w} className="flex items-start gap-1.5 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-ink-soft">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" /> {w}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-1.5">
              {DIMS.map((d) => {
                const on = dims.includes(d.key);
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setDims((ds) => (on ? ds.filter((x) => x !== d.key) : DIMS.map((x) => x.key).filter((k) => ds.includes(k) || k === d.key)))}
                    className={cx(
                      'focus-ring rounded-full border px-3 py-1 text-xs font-medium transition',
                      on ? 'border-ink bg-ink text-paper' : 'border-line bg-white text-ink-muted hover:text-ink',
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>

            <div className="scroll-thin mt-4 overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                    <th className="py-1.5 pr-2 font-medium">Size</th>
                    {dims.map((d) => (
                      <th key={d} className="whitespace-nowrap py-1.5 pr-2 font-medium">
                        {DIMS.find((x) => x.key === d)?.label} min–max
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5 pr-2">
                        <input
                          className={cx(inputClass, 'h-9 w-16')}
                          value={r.label}
                          aria-label="Size label"
                          onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                        />
                      </td>
                      {dims.map((d) => (
                        <td key={d} className="py-1.5 pr-2">
                          <div className="flex items-center gap-1">
                            {(['min', 'max'] as const).map((k) => (
                              <input
                                key={k}
                                className={cx(inputClass, 'h-9 w-16 px-2')}
                                inputMode="decimal"
                                placeholder={k}
                                aria-label={`${r.label} ${d} ${k}`}
                                value={r.cells[d]?.[k] ?? ''}
                                onChange={(e) => setCell(i, d, k, e.target.value)}
                              />
                            ))}
                          </div>
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          aria-label={`Remove size ${r.label}`}
                          className="focus-ring rounded-full p-1.5 text-ink-muted hover:text-bad"
                          onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRows((rs) => [...rs, { label: '', cells: {} }])}>
              <Plus className="h-4 w-4" /> Add size
            </Button>
          </Card>

          {/* 2 · details */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold">2 · Outfit details</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Segmented
                  size="sm"
                  value={brandMode}
                  onChange={setBrandMode}
                  options={[
                    { value: 'existing', label: 'Existing brand' },
                    { value: 'new', label: 'New brand' },
                  ]}
                />
                <div className="mt-2">
                  {brandMode === 'existing' ? (
                    <select className={inputClass} value={brandSlug} onChange={(e) => setBrandSlug(e.target.value)} aria-label="Brand">
                      {brands.map((b) => (
                        <option key={b.slug} value={b.slug}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className={inputClass} placeholder="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} aria-label="New brand name" />
                  )}
                </div>
              </div>
              <Field label="Name">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Linen Mandarin Shirt" />
              </Field>
              <Field label="Type">
                <input className={inputClass} list="subcats" value={subcategory} onChange={(e) => setSubcategory(e.target.value)} />
                <datalist id="subcats">
                  {SUBCATEGORIES.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </Field>
              <Field label="Category">
                <select
                  className={inputClass}
                  value={category}
                  onChange={(e) => {
                    const c = e.target.value as CreateGarmentRequest['category'];
                    setCategory(c);
                    if (!readInfo) setDims(CATEGORY_DIMS[c]!);
                  }}
                >
                  <option value="TOPS">Tops</option>
                  <option value="OUTERWEAR">Outerwear</option>
                  <option value="BOTTOMS">Bottoms</option>
                  <option value="DRESSES">Dresses</option>
                </select>
              </Field>
              <Field label="For">
                <select className={inputClass} value={gender} onChange={(e) => setGender(e.target.value as CreateGarmentRequest['gender'])}>
                  <option value="unisex">Everyone</option>
                  <option value="women">Women</option>
                  <option value="men">Men</option>
                </select>
              </Field>
              <Field label="Cut">
                <select className={inputClass} value={fitIntent} onChange={(e) => setFitIntent(e.target.value as CreateGarmentRequest['fitIntent'])}>
                  <option value="SLIM">Slim</option>
                  <option value="REGULAR">Regular</option>
                  <option value="RELAXED">Relaxed</option>
                  <option value="OVERSIZED">Oversized</option>
                </select>
              </Field>
              <Field label="Stretch">
                <select className={inputClass} value={stretch} onChange={(e) => setStretch(e.target.value as CreateGarmentRequest['stretch'])}>
                  <option value="NONE">None</option>
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                </select>
              </Field>
              <Field label="Material">
                <input className={inputClass} value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="e.g. 100% cotton" />
              </Field>
              <Field label="Price">
                <div className="flex gap-2">
                  <select className={cx(inputClass, 'w-24')} value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                    {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <input className={inputClass} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1999" aria-label="Price" />
                </div>
              </Field>
              <Field label="Colour">
                <div className="flex gap-2">
                  <input type="color" className="h-11 w-14 rounded-xl border border-line bg-white" value={colorHex} onChange={(e) => setColorHex(e.target.value)} aria-label="Colour" />
                  <input className={inputClass} value={colorName} onChange={(e) => setColorName(e.target.value)} placeholder="e.g. Indigo" aria-label="Colour name" />
                </div>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description">
                  <textarea
                    className={cx(inputClass, 'h-24 py-2.5')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="One or two sentences on the cut and feel."
                  />
                </Field>
              </div>
            </div>
          </Card>
        </div>

        {/* preview + save */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Card className="overflow-hidden p-0">
            <div className="aspect-square bg-gradient-to-b from-[#fbfaf6] to-[#efece4] p-10">
              <GarmentArt subcategory={subcategory} category={category} colorHex={colorHex} className="h-full w-full" />
            </div>
            <div className="p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
                {brandMode === 'existing' ? brands.find((b) => b.slug === brandSlug)?.name : brandName || 'New brand'}
              </p>
              <p className="mt-1 font-display text-2xl">{name || 'Outfit name'}</p>
              <p className="mt-1 text-sm text-ink-soft">
                {parseFloat(price) > 0 ? fmtPrice(Math.round(parseFloat(price) * 100), currency) : '—'}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{sizes.filter((s) => Object.keys(s.measurements).length).length} sizes</Badge>
                <Badge>{dims.length} measurements</Badge>
              </div>
              {error && <p className="mt-3 text-sm text-bad">{error}</p>}
              <Button variant="accent" size="lg" className="mt-4 w-full" loading={saving} onClick={save}>
                Add to shop
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function AdminOutfitsPage() {
  return <RequireUser>{(user) => <AddOutfit user={user} />}</RequireUser>;
}
