'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Download, Ghost, Info, Map as MapIcon, Pause, Play, RotateCcw, Shirt } from 'lucide-react';
import { api } from '@/lib/api';
import { garmentKind, type Kind } from '@/components/garment-art';
import {
  analyseBody,
  dress,
  isBottomKind,
  type BodyModel,
  type DressResult,
  type GarmentTexture,
} from '@/lib/garment3d';
import { DEFAULT_LANDMARKS, FIT_COLORS, type Landmarks, type ZoneTag } from '@/lib/tryon';
import type { AvatarRender, FitDimension, MeasurementsResponse, RecommendationView } from '@/lib/types';
import { Badge, Button, Card, Spinner, cx } from './ui';

const SKIN = new THREE.MeshStandardMaterial({
  color: '#d2ae96',
  roughness: 0.62,
  metalness: 0,
});

/** Measurement heights from the scan (fractions of stature): where this
 * body's chest, waist and hip are, for placing the garment's own. */
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

function dimsFor(rec: RecommendationView, size: string): FitDimension[] {
  const s = rec.sizes.find((x) => x.label === size);
  if (s?.dimensions) return s.dimensions;
  return size === rec.recommendedSize ? rec.dimensions : [];
}

/** The body as one welded, world-space geometry (smooth normals). */
function useBody(url: string) {
  const gltf = useGLTF(url);
  return useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
      g.applyMatrix4(mesh.matrixWorld);
      parts.push(g.index ? g.toNonIndexed() : g);
    });
    let body = parts.length === 1 ? parts[0]! : mergeGeometries(parts)!;
    body = mergeVertices(body, 1e-4);
    body.computeVertexNormals();
    return body;
  }, [gltf]);
}

/** Product texture (atlas for tops, fabric swatch for bottoms), if made. */
function useProductTexture(slug: string) {
  const [state, setState] = useState<{
    meta: GarmentTexture;
    map: THREE.Texture;
  } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    fetch(`/garments/tex/${slug}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<GarmentTexture>) : null))
      .then((meta) => {
        if (!meta || !live) return;
        new THREE.TextureLoader().load(`/garments/tex/${slug}.jpg`, (map) => {
          if (!live) return;
          map.colorSpace = THREE.SRGBColorSpace;
          map.anisotropy = 8;
          map.wrapS = THREE.RepeatWrapping;
          map.wrapT = meta.kind === 'bottom' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
          setState({ meta, map });
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug]);
  return state;
}

/** Strain lines for a top that's too small: shallow smiles across chest and
 * belly, pulled up toward the armpits (tangent-space normal map, atlas UVs). */
let strainMap: THREE.Texture | null = null;
function getStrainMap(): THREE.Texture {
  if (strainMap) return strainMap;
  const W = 512,
    Hh = 512;
  const h = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    const v = 1 - (y + 0.5) / Hh;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      if (v < 0.25) {
        // sleeves: rings bunching round the arm near the shoulder
        const along = u * 2;
        h[y * W + x] = along < 1 ? 0.6 * Math.max(0, 1 - along * 1.6) * Math.sin(along * 60) : 0;
        continue;
      }
      const uc = u < 0.5 ? 0.25 : 0.75;
      const du = (u - uc) / 0.25; // −1 … 1 across a panel
      const vv = (v - 0.25) / 0.75; // 0 hem … 1 collar
      const env = Math.max(0, 1 - du * du * 0.85) * Math.max(0, Math.sin(Math.PI * Math.min(1, vv / 0.85)));
      const line = vv * 15 + 2.4 * du * du + 0.35 * Math.sin(du * 5);
      h[y * W + x] = env * Math.sin(line * Math.PI) ** 2;
    }
  }
  const data = new Uint8Array(W * Hh * 4);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const hx = h[y * W + Math.min(W - 1, x + 1)]! - h[y * W + Math.max(0, x - 1)]!;
      const hy = h[Math.min(Hh - 1, y + 1) * W + x]! - h[Math.max(0, y - 1) * W + x]!;
      const n = new THREE.Vector3(-hx * 2, hy * 2, 1).normalize();
      const o = (y * W + x) * 4;
      data[o] = (n.x * 0.5 + 0.5) * 255;
      data[o + 1] = (n.y * 0.5 + 0.5) * 255;
      data[o + 2] = (n.z * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, Hh, THREE.RGBAFormat);
  t.flipY = true;
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  strainMap = t;
  return t;
}

function tagText(t: ZoneTag) {
  if (t.unsure) return `${t.label}: unsure`;
  if (Math.abs(t.deltaCm) < 1) return `${t.label} fits`;
  const word = t.isLength ? (t.deltaCm > 0 ? 'too short' : 'too long') : t.deltaCm > 0 ? 'too small' : 'too big';
  return `${t.label} ${Math.abs(t.deltaCm).toFixed(0)} cm ${word}`;
}

interface SceneProps {
  url: string;
  heightM: number;
  landmarks: Landmarks;
  armLengthCm?: number;
  kind: Kind;
  fitIntent: string;
  colorHex: string;
  dims: FitDimension[];
  step: number;
  ghostDims: FitDimension[] | null;
  tex: { meta: GarmentTexture; map: THREE.Texture } | null;
  fitMap: boolean;
  spin: boolean;
  onResult: (r: DressResult) => void;
}

function Scene(p: SceneProps) {
  const body = useBody(p.url);
  const model: BodyModel = useMemo(() => analyseBody(body, p.landmarks), [body, p.landmarks]);
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (p.spin && group.current) group.current.rotation.y += dt * 0.35;
  });
  const bottom = isBottomKind(p.kind);

  // What else they're wearing: plain jeans under a top, a plain tee over
  // trousers (a dress needs neither). Layered: the top stays outside.
  const under = useMemo(
    () =>
      bottom || p.kind === 'dress'
        ? null
        : dress(model, {
            kind: 'jeans',
            fitIntent: 'REGULAR',
            dims: [],
            step: 0,
            color: '#3b4252',
            plain: true,
          }),
    [model, bottom, p.kind],
  );
  const result = useMemo(
    () =>
      dress(model, {
        kind: p.kind,
        fitIntent: p.fitIntent,
        dims: p.dims,
        step: p.step,
        armLengthCm: p.armLengthCm,
        tex: p.tex?.meta ?? null,
        color: p.colorHex,
        over: under?.trunk,
      }),
    [model, p.kind, p.fitIntent, p.dims, p.step, p.armLengthCm, p.tex, p.colorHex, under],
  );
  const { onResult } = p;
  useEffect(() => onResult(result), [result, onResult]);
  const overTee = useMemo(
    () =>
      bottom
        ? dress(model, {
            kind: 'tee',
            fitIntent: 'REGULAR',
            dims: [],
            step: 0,
            color: '#efede6',
            plain: true,
            over: result.trunk,
          })
        : null,
    [model, bottom, result],
  );
  const companion = bottom ? overTee : under;

  const ghost = useMemo(
    () =>
      p.ghostDims
        ? dress(model, {
            kind: p.kind,
            fitIntent: p.fitIntent,
            dims: p.ghostDims,
            step: 0,
            color: p.colorHex,
          }).cloth
        : null,
    [model, p.ghostDims, p.kind, p.fitIntent, p.colorHex],
  );

  const tiled = p.tex?.meta.kind === 'bottom';
  const clothMat = useMemo(() => {
    if (p.fitMap)
      return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        side: THREE.DoubleSide,
      });
    const m = new THREE.MeshPhysicalMaterial({
      color: p.tex ? '#ffffff' : p.colorHex,
      map: p.tex?.map ?? null,
      roughness: 0.86,
      sheen: 0.55,
      sheenRoughness: 0.65,
      sheenColor: new THREE.Color('#ffffff'),
      side: THREE.DoubleSide,
    });
    if (!tiled && !bottom && result.tight > 0.2) {
      m.normalMap = getStrainMap();
      // Strain grows faster than tightness: a size that is a little small barely
      // creases, one that is far too small pulls hard.
      const k = 0.45 * result.tight ** 2;
      m.normalScale = new THREE.Vector2(k, k);
    }
    return m;
  }, [p.fitMap, p.tex, p.colorHex, tiled, bottom, result.tight]);
  const trimMat = useMemo(
    () =>
      p.fitMap
        ? new THREE.MeshStandardMaterial({
            color: '#9aa0a6',
            roughness: 0.85,
            side: THREE.DoubleSide,
          })
        : new THREE.MeshPhysicalMaterial({
            vertexColors: true,
            roughness: 0.8,
            sheen: 0.4,
            side: THREE.DoubleSide,
          }),
    [p.fitMap],
  );
  const companionMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: bottom ? '#efede6' : '#3b4252',
        roughness: 0.9,
        sheen: 0.35,
        side: THREE.DoubleSide,
        transparent: p.fitMap,
        opacity: p.fitMap ? 0.35 : 1,
      }),
    [bottom, p.fitMap],
  );
  const companionTrimMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const ghostMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#1f6f5c',
        wireframe: true,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    [],
  );

  return (
    <group ref={group}>
      <mesh geometry={body} material={SKIN} castShadow receiveShadow />
      {companion && <mesh geometry={companion.cloth} material={companionMat} castShadow />}
      {companion?.trim && !p.fitMap && <mesh geometry={companion.trim} material={companionTrimMat} />}
      <mesh geometry={result.cloth} material={clothMat} castShadow receiveShadow />
      {result.trim && <mesh geometry={result.trim} material={trimMat} castShadow />}
      {ghost && <mesh geometry={ghost} material={ghostMat} />}
      {p.fitMap &&
        result.tags.map((t) => (
          <Html key={t.name} position={t.position} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div
              className="-translate-y-1/2 whitespace-nowrap rounded-full border bg-white/95 px-2 py-0.5 text-[11px] font-medium shadow-soft"
              style={{ borderColor: t.color, color: t.color }}
            >
              {tagText(t)}
            </div>
          </Html>
        ))}
    </group>
  );
}

function summaryTone(s: string): 'bad' | 'warn' | 'good' | 'accent' {
  if (s === 'Very tight') return 'bad';
  if (s === 'Snug') return 'warn';
  if (s === 'True to size') return 'good';
  return 'accent';
}

/**
 * The 3D fitting room: the shopper's own body (from their scan) wearing this
 * product in any size — the product's own cloth, cut to that size's numbers.
 * Rotate it, switch sizes instantly, turn on the fit map or the outline of
 * your recommended size.
 */
export function Fitting3D({
  slug,
  garmentName,
  subcategory,
  category,
  fitIntent,
  colorHex,
  rec,
  selectedSize,
  onSelectSize,
  onNeedSize,
  busy,
}: {
  slug: string;
  garmentName: string;
  subcategory: string;
  category: string;
  fitIntent: string;
  colorHex: string;
  rec: RecommendationView | null;
  selectedSize: string | null;
  onSelectSize: (s: string) => void;
  onNeedSize: () => void;
  busy: boolean;
}) {
  const [avatar, setAvatar] = useState<AvatarRender | null | undefined>(undefined);
  const [meas, setMeas] = useState<MeasurementsResponse | null>(null);
  const [fitMap, setFitMap] = useState(false);
  const [ghostOn, setGhostOn] = useState(false);
  const [spin, setSpin] = useState(false);
  const [result, setResult] = useState<DressResult | null>(null);
  const controls = useRef<OrbitControlsImpl>(null);
  const card = useRef<HTMLDivElement>(null);
  const tex = useProductTexture(slug);
  const kind = garmentKind(subcategory, category);

  useEffect(() => {
    api<AvatarRender>('/me/avatar')
      .then(setAvatar)
      .catch(() => setAvatar(null));
    api<MeasurementsResponse>('/me/measurements')
      .then(setMeas)
      .catch(() => setMeas(null));
  }, []);
  const landmarks = useMemo(() => landmarksFrom(meas), [meas]);
  // Lets the demo script and tests turn the camera (window.__fit3d.object / .target).
  useEffect(() => {
    (window as unknown as { __fit3d?: unknown }).__fit3d = controls.current;
  });
  const armLengthCm = meas?.details?.find((d) => d.name === 'arm_length')?.value;
  const heightM = (meas?.heightCm ?? 172) / 100;

  const size = selectedSize ?? rec?.recommendedSize ?? null;
  const dims = useMemo(() => (rec && size ? dimsFor(rec, size) : []), [rec, size]);
  const labels = rec?.sizes.map((s) => s.label) ?? [];
  const step = rec && size ? labels.indexOf(size) - labels.indexOf(rec.recommendedSize) : 0;
  const ghostDims = useMemo(
    () => (rec && ghostOn && size !== rec.recommendedSize ? dimsFor(rec, rec.recommendedSize) : null),
    [rec, ghostOn, size],
  );

  if (avatar === undefined) {
    return (
      <Card className="grid aspect-square place-items-center">
        <Spinner />
      </Card>
    );
  }
  if (!avatar?.assets.glb) {
    return (
      <Card className="grid aspect-square place-items-center p-8 text-center">
        <div>
          <Shirt className="mx-auto h-8 w-8 text-ink-faint" />
          <p className="mt-3 text-sm text-ink-soft">Your 3D body appears here after a body scan.</p>
          <a href="/scan" className="mt-4 inline-block text-sm font-medium text-accent underline">
            Scan my body
          </a>
        </div>
      </Card>
    );
  }
  if (!rec || !size) {
    return (
      <Card className="grid aspect-square place-items-center p-8 text-center">
        <div>
          <p className="text-sm text-ink-soft">Find your size first — then try every size on your 3D body.</p>
          <Button className="mt-4" onClick={onNeedSize} disabled={busy}>
            {busy ? <Spinner /> : 'Find my size'}
          </Button>
        </div>
      </Card>
    );
  }

  const loud = dims.filter((d) => d.verdict && d.verdict !== 'good fit' && (d.weight ?? 1) > 0).slice(0, 3);
  return (
    <div className="space-y-3">
      <div ref={card}>
        <Card className="relative aspect-square overflow-hidden p-0">
          <Canvas
            shadows
            dpr={[1, 2]}
            camera={{
              position: [0.55, heightM * 0.68, heightM * 1.55],
              fov: 30,
              near: 0.05,
              far: 50,
            }}
            gl={{
              antialias: true,
              toneMapping: THREE.ACESFilmicToneMapping,
              toneMappingExposure: 1.05,
              // lets "save image" / screenshots read the canvas
              preserveDrawingBuffer: true,
            }}
          >
            <color attach="background" args={['#f1eee7']} />
            <hemisphereLight args={['#ffffff', '#c9bfb1', 0.75]} />
            <directionalLight
              position={[2.2, 4, 3.2]}
              intensity={1.9}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0004}
            />
            <directionalLight position={[-3, 2.2, 1.5]} intensity={0.55} color="#e8eeff" />
            <directionalLight position={[0, 2.5, -3.5]} intensity={0.9} color="#fff4e6" />
            <Suspense
              fallback={
                <Html center>
                  <span className="text-xs text-ink-muted">Loading your body…</span>
                </Html>
              }
            >
              <Scene
                url={avatar.assets.glb.url}
                heightM={heightM}
                landmarks={landmarks}
                armLengthCm={armLengthCm}
                kind={kind}
                fitIntent={fitIntent}
                colorHex={colorHex}
                dims={dims}
                step={step}
                ghostDims={ghostDims}
                tex={tex}
                fitMap={fitMap}
                spin={spin}
                onResult={setResult}
              />
            </Suspense>
            <ContactShadows position={[0, 0, 0]} opacity={0.4} scale={3} blur={2.4} far={2} />
            <OrbitControls
              ref={controls}
              target={[0, heightM * (isBottomKind(kind) ? 0.42 : 0.6), 0]}
              enablePan={false}
              minDistance={0.8}
              maxDistance={5}
              minPolarAngle={0.3}
              maxPolarAngle={Math.PI / 1.85}
              onStart={() => setSpin(false)}
            />
          </Canvas>

          <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">
            <Badge tone="accent">Size {size}</Badge>
            {result && <Badge tone={summaryTone(result.summary)}>{result.summary}</Badge>}
            {size === rec.recommendedSize && <Badge tone="neutral">your size</Badge>}
          </div>
          <div className="absolute bottom-3 right-3 flex gap-1.5">
            <IconButton title={fitMap ? 'Show the fabric' : 'Fit map'} on={fitMap} onClick={() => setFitMap((v) => !v)}>
              <MapIcon className="h-4 w-4" />
            </IconButton>
            {size !== rec.recommendedSize && (
              <IconButton
                title={`Outline of ${rec.recommendedSize} (your size)`}
                on={ghostOn}
                onClick={() => setGhostOn((v) => !v)}
              >
                <Ghost className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton title={spin ? 'Pause rotation' : 'Rotate'} on={spin} onClick={() => setSpin((v) => !v)}>
              {spin ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </IconButton>
            <IconButton title="Reset view" onClick={() => controls.current?.reset()}>
              <RotateCcw className="h-4 w-4" />
            </IconButton>
            <IconButton
              title="Save image"
              onClick={() => {
                const c = card.current?.querySelector('canvas');
                if (!c) return;
                const a = document.createElement('a');
                a.download = `${slug}-${size}.png`;
                a.href = c.toDataURL('image/png');
                a.click();
              }}
            >
              <Download className="h-4 w-4" />
            </IconButton>
          </div>
          {fitMap && <FitLegend />}
        </Card>
      </div>

      {loud.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {loud.map((d) => (
            <span
              key={d.name}
              className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor:
                  d.verdict.includes('tight') || d.verdict.includes('short') ? FIT_COLORS.tight : FIT_COLORS.loose,
              }}
            >
              {d.label}: {d.verdict}
              {d.outsideCm
                ? ` (${Math.abs(d.outsideCm).toFixed(0)} cm ${d.outsideCm > 0 ? 'over' : 'under'} the size)`
                : ''}
            </span>
          ))}
        </div>
      )}

      <div className="scroll-thin flex gap-2 overflow-x-auto p-1">
        {rec.sizes.map((s) => {
          const on = s.label === size;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onSelectSize(s.label)}
              aria-pressed={on}
              className={cx(
                'focus-ring relative flex min-w-[3.25rem] shrink-0 flex-col items-center rounded-xl border px-3 py-1.5 transition',
                s.label === rec.recommendedSize
                  ? 'border-ink bg-ink text-paper'
                  : 'border-line bg-white text-ink-soft hover:border-ink-faint',
                on && 'ring-2 ring-accent ring-offset-2 ring-offset-paper',
              )}
            >
              <span className="text-sm font-semibold">{s.label}</span>
              <span className={cx('text-[10px]', s.label === rec.recommendedSize ? 'text-paper/70' : 'text-ink-muted')}>
                {s.label === rec.recommendedSize ? 'yours' : s.blocked ? 'too small' : `${s.score}`}
              </span>
            </button>
          );
        })}
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Your 3D body from your scan, wearing the {garmentName} in size {size}: cut from this brand&apos;s size chart and
        your measurements, in the product&apos;s own fabric. A size too small clings, rides up and strains; a size too
        big hangs longer and folds. Drag to turn it round.
      </p>
    </div>
  );
}

function IconButton({
  title,
  on,
  onClick,
  children,
}: {
  title: string;
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'focus-ring grid h-9 w-9 place-items-center rounded-full border shadow-soft transition',
        on ? 'border-ink bg-ink text-paper' : 'border-line bg-white/90 text-ink-soft',
      )}
    >
      {children}
    </button>
  );
}

function FitLegend() {
  const items: [string, string][] = [
    [FIT_COLORS.tight, 'Too tight'],
    [FIT_COLORS.snug, 'Snug'],
    [FIT_COLORS.good, 'Good'],
    [FIT_COLORS.loose, 'Loose'],
  ];
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-xl bg-white/90 px-2.5 py-2 text-[10px] shadow-soft">
      {items.map(([c, t]) => (
        <span key={t} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: c }} />
          {t}
        </span>
      ))}
    </div>
  );
}
