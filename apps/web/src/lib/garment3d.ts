/**
 * The fitting room's 3D garments: the product, in the chosen size, on the
 * shopper's own scanned body.
 *
 * Cloth, not a body suit. At every height a garment spans the body the way
 * fabric (and a tape measure) does — across the hollow of the spine, under
 * the chest — so each cross-section of the body is replaced by its convex
 * hull. The size's ease (garment girth minus body girth: the same numbers as
 * the size recommendation) sets how far the cloth stands off that hull, and
 * cloth with room to spare falls from the fullest point instead of following
 * the body back in, folding as it hangs. A size changes what a mirror would
 * show: a tight one clings, rides up and grips the arms; a loose one hangs
 * longer, with wide sleeves and folds. The product photo, unwrapped into a
 * texture atlas (scripts/make-garment-textures.py), is wrapped round it.
 *
 * Geometric, not simulated, so every size rebuilds instantly: the body is
 * analysed once (`analyseBody`), each size is a fast `dress` over it.
 */

import * as THREE from 'three';
import type { Kind } from '@/components/garment-art';
import type { FitDimension } from '@/lib/types';
import {
  CUT_MULT,
  FIT_COLORS,
  SLEEVE_FRAC,
  SPECS,
  dimMap,
  interp,
  isUnsure,
  nearestZone,
  segment,
  verdictColor,
  type Cluster,
  type Landmarks,
  type Part,
  type ZoneTag,
} from '@/lib/tryon';

const NA = 96; // angles round a cross-section
const TWO_PI = Math.PI * 2;
const J_FRONT = 0.75 * NA; // θ = +π/2: straight ahead (+z)

type V2 = [number, number];
type Limb = 'armL' | 'armR';
type Leg = 'legL' | 'legR';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const angleOf = (j: number) => (j / NA) * TWO_PI - Math.PI;
const jOf = (theta: number) => (((((theta + Math.PI) / TWO_PI) * NA) % NA) + NA) % NA;

export interface GarmentTexture {
  kind: 'top' | 'bottom';
  pattern?: string;
  tone: string;
  collar?: string;
  cuff?: string;
  waistband?: string;
  tileCm?: number;
}

const BOTTOMS: Kind[] = ['jeans', 'trousers', 'joggers', 'shorts', 'skirt'];
export const isBottomKind = (k: Kind) => BOTTOMS.includes(k);

// ── geometry helpers ──

function convexHull(pts: V2[]): V2[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Radius of a convex polygon round (cx, cz) in each of NA directions; 0 if none. */
function polar(hull: V2[], cx: number, cz: number): Float64Array {
  const out = new Float64Array(NA);
  if (hull.length < 3) return out;
  for (let j = 0; j < NA; j++) {
    const th = angleOf(j);
    const dx = Math.cos(th),
      dz = Math.sin(th);
    let best = 0;
    for (let e = 0; e < hull.length; e++) {
      const a = hull[e]!,
        b = hull[(e + 1) % hull.length]!;
      const ex = b[0] - a[0],
        ez = b[1] - a[1];
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const ax = a[0] - cx,
        az = a[1] - cz;
      const t = (ax * ez - az * ex) / den;
      const s = (ax * dz - az * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    out[j] = best;
  }
  // Directions the ray missed (centre outside a thin section): span across.
  const known = [...out.keys()].filter((j) => out[j]! > 0);
  if (known.length === 0) return out;
  for (let j = 0; j < NA; j++) {
    if (out[j]! > 0) continue;
    let a = j,
      b = j;
    while (out[(a + NA) % NA]! <= 0) a--;
    while (out[b % NA]! <= 0) b++;
    const ra = out[(a + NA) % NA]!,
      rb = out[b % NA]!;
    out[j] = ra + ((rb - ra) * (j - a)) / (b - a);
  }
  return out;
}

function smoothRing(r: Float64Array, passes = 2): Float64Array {
  let cur = r;
  for (let p = 0; p < passes; p++) {
    const nxt = new Float64Array(NA);
    for (let j = 0; j < NA; j++) nxt[j] = 0.25 * cur[(j + NA - 1) % NA]! + 0.5 * cur[j]! + 0.25 * cur[(j + 1) % NA]!;
    cur = nxt;
  }
  return cur;
}

function sampleRing(r: Float64Array, jf: number): number {
  const j0 = Math.floor(jf) % NA;
  const t = jf - Math.floor(jf);
  return r[j0]! + (r[(j0 + 1) % NA]! - r[j0]!) * t;
}

/** Cumulative arc length round a polar ring, NA+1 entries (last = perimeter). */
function arcTable(r: Float64Array): Float64Array {
  const S = new Float64Array(NA + 1);
  for (let j = 0; j < NA; j++) {
    const a = angleOf(j),
      b = angleOf(j + 1);
    const ra = r[j]!,
      rb = r[(j + 1) % NA]!;
    S[j + 1] = S[j]! + Math.hypot(rb * Math.cos(b) - ra * Math.cos(a), rb * Math.sin(b) - ra * Math.sin(a));
  }
  return S;
}

function sampleArc(S: Float64Array, jf: number): number {
  const j0 = Math.floor(jf);
  const t = jf - j0;
  return S[j0]! + (S[Math.min(NA, j0 + 1)]! - S[j0]!) * t;
}

// ── the body, analysed once ──

export interface BodyModel {
  pos: THREE.BufferAttribute;
  nrm: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
  y0: number;
  H: number;
  s: number;
  cx: number;
  front: number;
  nb: number;
  l: Landmarks;
  part: Part[];
  bands: Cluster[][];
  /** Torso axis (x, z); per band, the hull radius round it — below the
   * crotch, the hull of both legs together (what a long garment hangs over). */
  ax: number;
  az: number;
  trunk: (Float64Array | null)[];
  legs: Record<Leg, { c: (V2 | null)[]; r: (Float64Array | null)[] }>;
  /** Per band: the arm's centre line, and arc length down it from the armpit. */
  arms: Record<
    Limb,
    {
      p: (THREE.Vector3 | null)[];
      t: (THREE.Vector3 | null)[];
      s: number[];
      root: number;
    }
  >;
  armpitK: number;
  shoulder: Record<Limb, THREE.Vector3>;
  neck: V2;
  /** Radius of the neck round `neck`, per direction (mid-neck). */
  neckR: Float64Array;
  /** Height where the neck meets the shoulders at the sides (side neck point). */
  neckSideY: number;
}

export function analyseBody(geometry: THREE.BufferGeometry, landmarks: Landmarks): BodyModel {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const index = geometry.getIndex()!;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const y0 = box.min.y;
  const H = box.max.y - box.min.y;
  const cx = (box.min.x + box.max.x) / 2;
  const s = H / 1.75;
  const seg = segment(pos, index, y0, H, cx, landmarks);
  const bands = seg.bands;
  const nb = bands.length;
  const l: Landmarks = { ...landmarks, crotch: seg.crotch };
  const bandOf = (y: number) => clamp(Math.floor(((y - y0) / H) * nb), 0, nb - 1);
  const bandY = (k: number) => y0 + ((k + 0.5) / nb) * H;
  const kAt = (f: number) => clamp(Math.floor(f * nb), 0, nb - 1);

  const partOf = (x: number, y: number): Part => {
    const k0 = bandOf(y);
    let best: Cluster | null = null,
      bestD = Infinity;
    for (const dk of [0, -1, 1, -2, 2]) {
      const cls = bands[k0 + dk];
      if (!cls) continue;
      for (const cl of cls) {
        const d = x < cl.min ? cl.min - x : x > cl.max ? x - cl.max : 0;
        if (d < bestD - 1e-9) {
          bestD = d;
          best = cl;
        }
      }
      if (bestD < 0.004 * s) break;
    }
    if (!best) return 'torso';
    return bestD > 0.03 * s ? 'hand' : best.part;
  };

  const n = pos.count;
  const part: Part[] = new Array(n);
  for (let i = 0; i < n; i++) part[i] = partOf(pos.getX(i), pos.getY(i));

  // Cross-section outlines per band and part.
  const pts = Array.from({ length: nb }, () => ({
    torso: [] as V2[],
    legL: [] as V2[],
    legR: [] as V2[],
  }));
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const tri = [a, b, c];
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(pos, index.getX(t));
    b.fromBufferAttribute(pos, index.getX(t + 1));
    c.fromBufferAttribute(pos, index.getX(t + 2));
    const lo = Math.min(a.y, b.y, c.y),
      hi = Math.max(a.y, b.y, c.y);
    const k0 = Math.max(0, Math.ceil(((lo - y0) / H) * nb - 0.5));
    const k1 = Math.min(nb - 1, Math.floor(((hi - y0) / H) * nb - 0.5));
    for (let k = k0; k <= k1; k++) {
      const y = bandY(k);
      for (let e = 0; e < 3; e++) {
        const p = tri[e]!,
          q = tri[(e + 1) % 3]!;
        if ((p.y - y) * (q.y - y) >= 0) continue;
        const u = (y - p.y) / (q.y - p.y);
        const x = p.x + u * (q.x - p.x),
          z = p.z + u * (q.z - p.z);
        const pp = partOf(x, y);
        if (pp === 'torso' || pp === 'legL' || pp === 'legR') pts[k]![pp].push([x, z]);
      }
    }
  }

  // Torso axis: the middle of the trunk between hip and chest.
  let sx = 0,
    sz = 0,
    cnt = 0;
  for (let k = kAt(l.hip); k <= kAt(l.chest); k++) {
    const hull = convexHull(pts[k]!.torso);
    for (const p of hull) {
      sx += p[0];
      sz += p[1];
      cnt++;
    }
  }
  const ax = cnt ? sx / cnt : cx;
  const az = cnt ? sz / cnt : (box.min.z + box.max.z) / 2;
  const kCrotch = kAt(l.crotch);
  const trunk = pts.map((p, k) => {
    const src = k >= kCrotch ? p.torso : p.legL.concat(p.legR);
    const hull = convexHull(src);
    return hull.length >= 3 ? polar(hull, ax, az) : null;
  });

  // Legs: a centre per band (smoothed down the leg), the hull round it.
  const legs = {} as BodyModel['legs'];
  for (const leg of ['legL', 'legR'] as Leg[]) {
    const raw = pts.map((p) => {
      const h = convexHull(p[leg]);
      if (h.length < 3) return null;
      return [h.reduce((m, q) => m + q[0], 0) / h.length, h.reduce((m, q) => m + q[1], 0) / h.length] as V2;
    });
    const cs = raw.map((_, k) => {
      let mx = 0,
        mz = 0,
        m = 0;
      for (let d = -3; d <= 3; d++) {
        const q = raw[k + d];
        if (q) {
          mx += q[0];
          mz += q[1];
          m++;
        }
      }
      return raw[k] && m ? ([mx / m, mz / m] as V2) : null;
    });
    legs[leg] = {
      c: cs,
      r: cs.map((cc, k) => (cc ? smoothRing(polar(convexHull(pts[k]![leg]), cc[0], cc[1]), 1) : null)),
    };
  }

  // Arms: the centre line, band by band.
  const arms = {} as BodyModel['arms'];
  for (const arm of ['armL', 'armR'] as Limb[]) {
    const sum = Array.from({ length: nb }, () => [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      if (part[i] !== arm) continue;
      const k = bandOf(pos.getY(i));
      sum[k]![0] += pos.getX(i);
      sum[k]![1] += pos.getZ(i);
      sum[k]![2]++;
    }
    const raw = sum.map((q, k) => (q[2] >= 3 ? new THREE.Vector3(q[0] / q[2], bandY(k), q[1] / q[2]) : null));
    const p = raw.map((q, k) => {
      if (!q) return null;
      const acc = new THREE.Vector3();
      let m = 0;
      for (let d = -2; d <= 2; d++) {
        const r = raw[k + d];
        if (r) {
          acc.add(r);
          m++;
        }
      }
      return acc.divideScalar(m);
    });
    let root = -1;
    for (let k = nb - 1; k >= 0; k--)
      if (p[k]) {
        root = k;
        break;
      }
    const tang = p.map((q, k) => {
      if (!q) return null;
      const up = p[Math.min(nb - 1, k + 2)] ?? q,
        dn = p[Math.max(0, k - 2)] ?? q;
      const t = new THREE.Vector3().subVectors(dn, up);
      return t.lengthSq() > 1e-10 ? t.normalize() : new THREE.Vector3(0, -1, 0);
    });
    const sArr = new Array<number>(nb).fill(0);
    for (let k = root - 1; k >= 0; k--) {
      const q = p[k],
        r = p[k + 1];
      sArr[k] = sArr[k + 1]! + (q && r ? q.distanceTo(r) : 0);
    }
    arms[arm] = { p, t: tang, s: sArr, root };
  }

  // The armpit: the highest band where both arms stand apart from the torso.
  let armpitK = kAt(l.chest);
  for (let k = kAt(l.chest); k < Math.min(nb, kAt(l.shoulder) + 6); k++) {
    const cls = bands[k]!;
    if (cls.some((cl) => cl.part === 'armL') && cls.some((cl) => cl.part === 'armR')) armpitK = k;
    else break;
  }

  const kS = kAt(l.shoulder);
  const torsoAtShoulder = bands[kS]!.find((cl) => cl.part === 'torso');
  const shoulder = {
    armL: new THREE.Vector3(torsoAtShoulder?.min ?? cx - 0.18 * s, y0 + l.shoulder * H, az),
    armR: new THREE.Vector3(torsoAtShoulder?.max ?? cx + 0.18 * s, y0 + l.shoulder * H, az),
  };
  const neckHull = convexHull(pts[kAt(l.neck)]!.torso);
  const neck: V2 = neckHull.length
    ? [
        neckHull.reduce((m, q) => m + q[0], 0) / neckHull.length,
        neckHull.reduce((m, q) => m + q[1], 0) / neckHull.length,
      ]
    : [ax, az];
  let neckR =
    neckHull.length >= 3 ? smoothRing(polar(neckHull, neck[0], neck[1]), 2) : new Float64Array(NA).fill(0.06 * s);
  // A thick slice (trapezius caught in it) would open the collar too wide.
  const meanNeck = neckR.reduce((m, r) => m + r, 0) / NA;
  if (meanNeck > 0.085 * s || meanNeck < 0.035 * s) neckR = new Float64Array(NA).fill(0.06 * s);
  // Side neck point: at the sides, where the body flares out past the neck.
  const sideYs: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    if (part[i] !== 'torso' || y < y0 + l.shoulder * H - 0.04 * s || y > y0 + l.neck * H + 0.02 * s) continue;
    const dx = pos.getX(i) - neck[0],
      dz = pos.getZ(i) - neck[1];
    const phi = Math.atan2(dz, dx);
    if (Math.abs(Math.sin(phi)) > 0.35) continue;
    const r = Math.hypot(dx, dz) - sampleRing(neckR, jOf(phi));
    if (r > 0.008 * s && r < 0.02 * s) sideYs.push(y);
  }
  sideYs.sort((p, q) => p - q);
  const neckSideY = sideYs.length ? sideYs[Math.floor(sideYs.length * 0.7)]! : y0 + (l.neck - 0.02) * H;

  return {
    pos,
    nrm,
    index,
    y0,
    H,
    s,
    cx,
    front: box.max.z,
    nb,
    l,
    part,
    bands,
    ax,
    az,
    trunk,
    legs,
    arms,
    armpitK,
    shoulder,
    neck,
    neckR,
    neckSideY,
  };
}

// ── dressing it ──

export interface DressInput {
  kind: Kind;
  fitIntent: string;
  dims: FitDimension[];
  /** This size's place relative to the recommended one (−2 = two sizes down). */
  step: number;
  armLengthCm?: number;
  tex?: GarmentTexture | null;
  /** The product's colour (used for trims when there is no texture). */
  color: string;
  /** A plain companion piece (trousers under the top being tried on): its
   * design ease, no fit colours. */
  plain?: boolean;
  /** The trunk of a garment worn underneath (`DressResult.trunk`): this one
   * stays outside it, as a top over a waistband. */
  over?: (Float64Array | null)[] | null;
}

export interface DressResult {
  cloth: THREE.BufferGeometry; // position, normal, uv, color (fit map)
  trim: THREE.BufferGeometry | null; // collar, cuffs, waistband
  tags: ZoneTag[];
  tight: number;
  loose: number;
  summary: string;
  hemY: number;
  /** Texture coordinates are metres / tile (bottoms), or the top atlas. */
  tiled: boolean;
  /** Radius round the torso axis per band (for layering another garment over it). */
  trunk: (Float64Array | null)[];
}

/** Fit words from the strain and drape numbers (as the photo fitting room). */
export function fitSummary(tight: number, loose: number): string {
  if (tight > 0.75) return 'Very tight';
  if (tight > 0.35) return 'Snug';
  if (loose > 0.75) return 'Very loose';
  if (loose > 0.35) return 'Relaxed';
  return 'True to size';
}

// Record layout for the clipper: position, normal, trunk uv, limb uv,
// colour, cover (>= 0 inside the garment), trim (distance from an opening),
// seam (>= 0 on the limb side of the armhole / crotch seam).
const R = {
  x: 0,
  nx: 3,
  u: 6,
  ul: 8,
  r: 10,
  cov: 13,
  trim: 14,
  seam: 15,
  len: 16,
} as const;

export function dress(b: BodyModel, input: DressInput): DressResult {
  const { pos, nrm, index, l, H, y0, s, nb, part } = b;
  const spec = SPECS[input.kind];
  const bottom = isBottomKind(input.kind);
  const cut = CUT_MULT[input.fitIntent] ?? 1;
  const dims = dimMap(input.plain ? [] : input.dims);
  const bandOf = (y: number) => clamp(Math.floor(((y - y0) / H) * nb), 0, nb - 1);
  const bandF = (y: number) => clamp(((y - y0) / H) * nb - 0.5, 0, nb - 1);
  const thick = 0.0035 * s;
  // A plain companion top sits a little further out, over whatever trousers
  // are being tried on.
  const layer = input.plain && !isBottomKind(input.kind) ? 0.008 * s : 0;
  const toM = (easeCm: number) => Math.max(easeCm, 0) / TWO_PI / 100;

  // How tight or loose this size is overall (as the photo fitting room).
  const room = (name: string, d = 0) => dims.get(name)?.roomCm ?? d;
  const chestR = room('chest', room('waist'));
  const waistR = room('waist', chestR);
  const hipR = room('hip', waistR);
  const key = bottom ? (waistR + hipR) / 2 : chestR;
  let tight = clamp01((-key - 2) / 13);
  let loose = clamp01((key - 3) / 13);
  for (const nm of ['chest', 'waist', 'hip']) {
    const d = dims.get(nm);
    if (d && d.verdict === 'too tight') tight = Math.max(tight, Math.min(1, 0.45 + (d.outsideCm ?? 0) / 14));
  }
  if (input.plain) tight = loose = 0;
  const step = input.plain ? 0 : input.step;

  // Ease (cm) per zone: design ease for this kind and cut, less how far the
  // body is outside this size's range (the engine's outsideCm).
  const easeFor = (name: string, design: number, fallback?: string): number => {
    const d = dims.get(name) ?? (fallback ? dims.get(fallback) : undefined);
    if (!d) return design;
    return d.outsideCm !== undefined ? design - d.outsideCm : design + d.roomCm;
  };
  const easeChest = easeFor('chest', spec.ease.chest * cut);
  const easeWaist = easeFor('waist', spec.ease.waist * cut);
  const easeHip = easeFor('hip', spec.ease.hip * cut, 'waist');
  const easeThigh = easeFor('thigh', spec.ease.thigh * cut, 'hip');
  const torsoKnots: [number, number][] = [];
  if (spec.ease.chest > 0) torsoKnots.push([l.shoulder, easeChest * 0.8], [l.chest, easeChest]);
  torsoKnots.push([l.waist, easeWaist], [l.hip, easeHip]);

  // Length: shorter in smaller sizes, and a tight top rides up.
  const lengthCm = 2.2 * step - 6 * tight + 1.5 * loose;
  let hemF = spec.hem(l) - lengthCm / (H * 100);
  const inseam = dims.get('inseam');
  // Trousers longer than the leg stack up over the shoe rather than cover the
  // foot; the extra length shows as folds at the ankle.
  const ANKLE = 0.045;
  let stackCm = 0;
  if (spec.legs === 'long') {
    const want = inseam
      ? l.crotch - (inseam.range[0] + inseam.range[1]) / 2 / (H * 100)
      : hemF - (step * 1.5) / (H * 100);
    hemF = Math.max(ANKLE, want);
    stackCm = Math.max(0, (ANKLE - want) * H * 100);
  }
  if (!bottom) hemF = Math.max(hemF, 0.2);
  const hemY0 = y0 + hemF * H;
  // Plain companion trousers sit at mid-rise, like most jeans.
  const topF = input.plain && bottom ? (l.waist + l.hip) / 2 + 0.01 : spec.top(l);
  const topY = y0 + topF * H;
  // A top long enough to reach the crotch hangs from just above it, as cloth
  // does, rather than following the legs apart.
  const hangs = !bottom && !spec.drape && hemF < l.crotch + 0.035;
  const drapeF = spec.drape ? (bottom ? l.hip : l.hip - 0.01) : hangs ? l.crotch + 0.045 : -1;
  const longTop = !bottom && (spec.drape || hangs) && hemF < drapeF;

  // Drape: how much of the room falls straight rather than following the body.
  const lam = clamp(0.64 + 0.34 * loose - 0.95 * tight - (input.fitIntent === 'SLIM' ? 0.2 : 0), 0, 0.97);

  // ── trunk: the garment's radius per band ──
  const kTop = bottom ? Math.min(nb - 1, bandOf(topY) + 4) : b.armpitK;
  const kLowest = longTop || bottom ? bandOf(y0 + l.crotch * H) : bandOf(hemY0) - 3;
  const kBot = Math.max(0, Math.min(kLowest, bandOf(hemY0) - 3));
  const G: (Float64Array | null)[] = new Array(nb).fill(null);
  const own: (Float64Array | null)[] = new Array(nb).fill(null);
  let prev: Float64Array | null = null;
  for (let k = kTop; k >= kBot; k--) {
    const tr = b.trunk[k];
    if (!tr) continue;
    const off = toM(interp(torsoKnots, (k + 0.5) / nb)) + thick + layer;
    const under = input.over?.[k];
    const o = tr.map((r, j) => Math.max(r + off, under ? under[j]! + 0.005 * s : 0));
    own[k] = o;
    const lk = bottom ? 0.35 * lam : lam;
    G[k] = prev ? o.map((r, j) => Math.max(r, lk * prev![j]! + (1 - lk) * r)) : o;
    prev = G[k];
  }
  // Smooth round and down; never inside the body.
  for (let k = kBot; k <= kTop; k++) if (G[k]) G[k] = smoothRing(G[k]!, 2);
  for (let pass = 0; pass < 4; pass++) {
    const copy = G.slice();
    for (let k = kBot + 1; k < kTop; k++) {
      if (!G[k] || !copy[k - 1] || !copy[k + 1]) continue;
      G[k] = G[k]!.map((r, j) => Math.max(own[k]![j]!, 0.25 * copy[k - 1]![j]! + 0.5 * r + 0.25 * copy[k + 1]![j]!));
    }
  }
  // Folds where the cloth hangs free of the body (more room, deeper folds).
  const kChest = bandOf(y0 + l.chest * H);
  for (let k = kBot; k <= Math.min(kTop, kChest); k++) {
    if (!G[k] || bottom) continue;
    const below = clamp01((kChest - k) / Math.max(1, kChest - bandOf(hemY0)));
    G[k] = G[k]!.map((r, j) => {
      const th = angleOf(j);
      const fold = 0.5 + 0.5 * Math.sin(7 * th + 1.3 + 0.9 * Math.sin(3 * th + 0.4));
      const free = r - own[k]![j]!;
      const amp = Math.min(free * 0.6, (0.004 + 0.02 * loose) * s) + (0.0015 + 0.004 * loose) * s * (1 - tight) * below;
      return r + amp * fold * below;
    });
  }
  const arcs = G.map((g) => (g ? arcTable(g) : null));
  const nearestK = (k: number) => {
    for (let d = 0; d < nb; d++) {
      if (G[k - d]) return k - d;
      if (G[k + d]) return k + d;
    }
    return -1;
  };
  const sampleG = (kf: number, jf: number): number => {
    const k0 = Math.floor(kf),
      t = kf - k0;
    const a0 = G[nearestK(clamp(k0, kBot, kTop))]!,
      a1 = G[nearestK(clamp(k0 + 1, kBot, kTop))]!;
    return (1 - t) * sampleRing(a0, jf) + t * sampleRing(a1, jf);
  };
  // Atlas u round the trunk: front centre 0.25, wearer's left side 0.5, back
  // centre 0.75 — arc length on the garment, as cloth unrolls flat.
  // One unrolling for the whole trunk (the chest's), so stripes and plackets
  // run straight down instead of jogging where the cloth starts to hang.
  const kArc = nearestK(clamp(kChest, kBot, Math.min(kTop, b.armpitK)));
  const uRound = (_kf: number, jf: number): number => {
    const S = arcs[kArc];
    if (!S) return 0.25;
    const P = S[NA]!;
    const u = 0.25 + (sampleArc(S, J_FRONT) - sampleArc(S, jf)) / P;
    return ((u % 1) + 1) % 1;
  };

  // Neckline: an oval opening round the base of the neck — the neck's own
  // outline plus a little room, scooped lower in front — so the collar hugs
  // the neck all the way round instead of running out along the shoulders.
  // Three limits, each measured along the body so the rib is even all round:
  // a ring a little out from the neck (the opening hugs the neck), a plane
  // tilting down to the front (the crew scoop), and no higher than the side
  // neck point (no points riding up the neck).
  const collared = ['shirt', 'blazer', 'coat', 'jacket', 'polo'].includes(input.kind);
  const drop = (input.kind === 'vest' ? 0.13 : collared ? 0.045 : 0.075) * s;
  const neckEase = 0.012 * s;
  const sideY = Math.min(b.neckSideY, topY) + 0.008 * s;
  const tilt = drop / (sampleRing(b.neckR, J_FRONT) + 0.02 * s);
  // The scoop's cut curves up toward the sides: a round crew, not a V.
  const curve = (0.02 * s) / (0.06 * s) ** 2;
  const gv = new THREE.Vector3();
  const alongBody = (g: THREE.Vector3, nrmv: THREE.Vector3) => {
    const gl = g.length();
    const d = g.dot(nrmv);
    return Math.max(0.3 * gl, Math.sqrt(Math.max(0, gl * gl - d * d)));
  };
  /** Distance (along the body) from the neckline: + on the garment. */
  const neckOpen = (p: THREE.Vector3, nrmv: THREE.Vector3) => {
    const dx = p.x - b.neck[0],
      dz = p.z - b.neck[1];
    const rh = Math.hypot(dx, dz) || 1e-6;
    // More room at the sides, where the neck runs into the shoulders.
    const side = (dx / rh) ** 2;
    const ring =
      (rh - sampleRing(b.neckR, jOf(Math.atan2(dz, dx))) - neckEase - 0.01 * s * side) /
      alongBody(gv.set(dx / rh, 0, dz / rh), nrmv);
    const fwd = Math.max(0, dz);
    const lift = curve * dx * dx * Math.min(1, fwd / 0.03);
    const scoopPlane =
      (sideY - tilt * fwd + lift - p.y) / alongBody(gv.set(dz > 0 ? 2 * curve * dx : 0, -1, dz > 0 ? -tilt : 0), nrmv);
    return Math.min(ring, scoopPlane);
  };
  const hemY = (x: number, z: number) => {
    const th = Math.atan2(z - b.az, x - b.ax);
    // A top that's too small rides up most at the front, over the belly.
    const ride = 0.035 * s * tight * Math.max(0, Math.sin(th)) ** 1.5;
    if (input.kind !== 'shirt') return hemY0 + ride;
    return hemY0 + ride + 0.035 * s * (Math.cos(th) ** 2 - 0.4); // shirt-tail: higher at the sides
  };

  // Sleeves.
  const armLen = (input.armLengthCm ?? 0.27 * H * 100) / 100;
  const armDim = dims.get('arm_length');
  const garmentArm = armDim ? (armDim.range[0] + armDim.range[1]) / 200 : armLen + 0.01 * step;
  let reach = spec.sleeve === 'long' ? garmentArm : SLEEVE_FRAC[spec.sleeve] * armLen + 0.012 * step;
  reach -= 0.02 * tight;
  const armEase = Math.max(1, 0.4 * easeChest + 5) * (1 - 0.7 * tight);
  const yokeEase = toM(Math.max(0.5, (0.25 + 0.3 * loose) * easeChest + 2)) + thick;
  const yokeY = y0 + ((b.armpitK + 0.5) / nb) * H;
  // Sleeve length runs straight down each arm from the shoulder point (the
  // rest pose holds the arms straight), so cuffs are clean cuts across it.
  const armAxis = {} as Record<Limb, THREE.Vector3>;
  for (const arm of ['armL', 'armR'] as Limb[]) {
    const ps = b.arms[arm].p;
    let low: THREE.Vector3 | null = null;
    for (let k = 0; k < nb && !low; k++) low = ps[k] ?? null;
    armAxis[arm] = low
      ? low.clone().sub(b.shoulder[arm]).normalize()
      : new THREE.Vector3(arm === 'armL' ? -0.6 : 0.6, -0.8, 0);
  }
  const d2 = new THREE.Vector3();
  const alongArm = (side: Limb, p: THREE.Vector3) => d2.subVectors(p, b.shoulder[side]).dot(armAxis[side]);
  // Set-in armhole: seen from the front, the line from the shoulder point down
  // to the armpit. Outside it is sleeve.
  const torsoAtPit = b.bands[b.armpitK]!.find((cl) => cl.part === 'torso');
  const armhole = {} as Record<Limb, { x: number; y: number; nx: number; ny: number }>;
  for (const arm of ['armL', 'armR'] as Limb[]) {
    const sgn = arm === 'armL' ? -1 : 1;
    const apx = torsoAtPit ? (sgn < 0 ? torsoAtPit.min : torsoAtPit.max) : b.shoulder[arm].x;
    const dx = b.shoulder[arm].x - apx,
      dy = b.shoulder[arm].y - yokeY;
    const len = Math.hypot(dx, dy) || 1;
    // unit normal to the line, pointing away from the body's middle
    let nx = dy / len,
      ny = -dx / len;
    if (nx * sgn < 0) {
      nx = -nx;
      ny = -ny;
    }
    armhole[arm] = { x: apx, y: yokeY, nx, ny };
  }
  const outsideArmhole = (side: Limb, p: THREE.Vector3) =>
    (p.x - armhole[side].x) * armhole[side].nx + (p.y - armhole[side].y) * armhole[side].ny;

  // Leg drape: jeans follow the leg, trousers fall from the thigh.
  const legLam = clamp(
    ((
      {
        jeans: 0.35,
        trousers: 0.82,
        joggers: 0.55,
        shorts: 0.6,
        skirt: 0,
      } as Record<string, number>
    )[input.kind] ?? 0.6) +
      0.3 * loose -
      0.6 * tight,
    0,
    0.97,
  );
  const legKnots: [number, number][] = [
    [l.crotch - 0.02, easeThigh],
    [0.28, easeThigh * (input.kind === 'jeans' ? 0.75 : 0.8)],
    [0.06, easeThigh * (input.kind === 'joggers' ? 0.15 : 0.7)],
  ];
  const legG = {} as Record<Leg, (Float64Array | null)[]>;
  for (const leg of ['legL', 'legR'] as Leg[]) {
    const out: (Float64Array | null)[] = new Array(nb).fill(null);
    let up: Float64Array | null = null;
    if (spec.legs !== 'none') {
      for (let k = bandOf(y0 + l.crotch * H); k >= Math.max(0, bandOf(hemY0) - 3); k--) {
        const r = b.legs[leg].r[k];
        if (!r) continue;
        const o = r.map((x) => x + toM(interp(legKnots, (k + 0.5) / nb)) + thick);
        // Jogger cuffs gather back to the ankle.
        const gather =
          input.kind === 'joggers' ? smoothstep(hemY0 + 0.08 * s, hemY0 + 0.02 * s, y0 + ((k + 0.5) / nb) * H) : 0;
        const lk = legLam * (1 - gather);
        out[k] = up ? o.map((x, j) => Math.max(x, lk * up![j]! + (1 - lk) * x)) : o;
        up = out[k];
        // Extra length stacks in soft rings just above the hem.
        const yk = y0 + ((k + 0.5) / nb) * H;
        const near = smoothstep(hemY0 + 0.1 * s, hemY0 + 0.01 * s, yk);
        if (stackCm > 0.5 && near > 0) {
          const amp = Math.min(0.012, 0.0012 * stackCm) * s * near;
          const ring = 0.5 + 0.5 * Math.sin(((yk - hemY0) / (0.045 * s)) * TWO_PI);
          out[k] = out[k]!.map((x) => x + amp * ring);
        }
      }
    }
    legG[leg] = out;
  }

  // Fit colours.
  const zoneColor = new Map<string, THREE.Color>();
  for (const [name, d] of dims)
    zoneColor.set(name, new THREE.Color(isUnsure(d) ? FIT_COLORS.unsure : verdictColor(d.verdict)));
  const fallback = new THREE.Color(FIT_COLORS.good);

  // Texture scale for tiled cloth (bottoms).
  const tileM = ((input.tex?.tileCm ?? 18) / 100) * 1.0;

  // ── per vertex: where the cloth sits, its texture coordinates, coverage ──
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const UV = new Float32Array(n * 2); // trunk chart
  const UVL = new Float32Array(n * 2); // limb chart
  const limbV = new Uint8Array(n);
  const seamV = new Float32Array(n).fill(-1);
  const COL = new Float32Array(n * 3);
  const cov = new Float32Array(n).fill(-1);
  const trimD = new Float32Array(n).fill(1e3);
  const v = new THREE.Vector3(),
    nv = new THREE.Vector3(),
    d = new THREE.Vector3(),
    q = new THREE.Vector3();
  const OUT = -0.02;
  const vSpan = Math.max(0.05, topY - hemY0);
  const crotchY = y0 + l.crotch * H;
  const panelV = (y: number) => clamp(0.25 + 0.75 * ((y - hemY0) / vSpan), 0.252, 0.998);
  const q2 = new THREE.Vector3(),
    fwd = new THREE.Vector3();
  const sleeveUV = (i: number, side: Limb, p: THREE.Vector3, along: number) => {
    const A = armAxis[side];
    q2.subVectors(p, b.shoulder[side]).addScaledVector(A, -along).normalize();
    fwd.set(0, 0, 1).addScaledVector(A, -A.z).normalize();
    const around = Math.acos(clamp(q2.dot(fwd), -1, 1)) / Math.PI; // 0 front … 1 back, mirrored
    UVL[i * 2] = 0.5 * clamp(along / Math.max(reach, 0.05), 0, 1) * 0.985 + 0.003;
    UVL[i * 2 + 1] = 0.25 * (0.04 + 0.92 * (1 - around));
    limbV[i] = 1;
  };

  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i);
    const pt = part[i]!;
    const f = (v.y - y0) / H;
    let out = v.clone().addScaledVector(nv, thick);
    let c = OUT;
    let trim = 1e3;
    let zone = '';
    const th = Math.atan2(v.z - b.az, v.x - b.ax);
    const jf = jOf(th);
    const kf = bandF(v.y);
    UV[i * 2] = uRound(kf, jf);
    UV[i * 2 + 1] = panelV(v.y);
    if (bottom) {
      const S = arcs[nearestK(clamp(Math.round(kf), kBot, kTop))];
      UV[i * 2] = (S ? sampleArc(S, jf) : 0) / tileM;
      UV[i * 2 + 1] = v.y / tileM;
    }

    if (pt === 'torso') {
      // Above the armpit (yoke, shoulders): just off the body. Below: the hull.
      const w = bottom
        ? (1 - smoothstep(topY + 0.02 * s, topY + 0.06 * s, v.y)) * smoothstep(crotchY, crotchY + 0.05 * s, v.y)
        : 1 - smoothstep(yokeY - 0.03 * s, yokeY + 0.08 * s, v.y);
      const yoke = v.clone().addScaledVector(nv, bottom ? thick + 0.6 * toM(interp(torsoKnots, f)) : yokeEase);
      if (w > 0 && kf >= kBot - 1) {
        const rb = Math.hypot(v.x - b.ax, v.z - b.az);
        const rg = Math.max(sampleG(kf, jf), rb + thick);
        const hp = new THREE.Vector3(b.ax + Math.cos(th) * rg, v.y, b.az + Math.sin(th) * rg);
        out = yoke.lerp(hp, w);
      } else out = yoke;
      if (bottom) {
        c = topY - v.y;
        trim = c;
        zone = nearestZone(f, l, dims, ['waist', 'hip']);
      } else {
        const no = neckOpen(v, nv);
        const lowEdge = longTop ? y0 + (drapeF - 0.003) * H : hemY(v.x, v.z);
        c = Math.min(v.y - lowEdge, no);
        trim = no;
        // Out past the shoulder point the cloth is sleeve, whatever the
        // segmentation called it: cut and textured as the sleeve.
        // Above the armpit, out past the shoulder point, the cloth is the
        // sleeve's (the segmentation calls the shoulder cap torso).
        if (v.y > yokeY - 0.01 * s) {
          const side: Limb = v.x < b.ax ? 'armL' : 'armR';
          const out2 = outsideArmhole(side, v) - 0.004 * s;
          if (spec.sleeve === 'none') {
            c = Math.min(c, -out2);
          } else {
            const along = alongArm(side, v);
            if (out2 > 0) {
              c = Math.min(c, reach - along);
              trim = Math.min(trim, reach - along);
              // Past the armhole: the sleeve's own room (as on the underside),
              // so cap and underside open evenly at the cuff.
              const t = clamp01(along / Math.max(reach, 0.05));
              const offM = toM(armEase) * (1 + 0.5 * loose * t) + thick;
              const sleevePos = v.clone().addScaledVector(nv, offM);
              out = out.lerp(sleevePos, smoothstep(0, 0.03 * s, out2));
            }
            sleeveUV(i, side, v, along);
            seamV[i] = out2;
          }
        }
        zone =
          f > (l.chest + l.shoulder) / 2 && dims.has('shoulder_width')
            ? 'shoulder_width'
            : nearestZone(f, l, dims, ['chest', 'waist', 'hip']);
      }
    } else if ((pt === 'armL' || pt === 'armR') && !bottom) {
      const arm = b.arms[pt];
      const k = bandOf(v.y);
      let kk = k;
      for (let dk = 0; dk < 12; dk++) {
        if (arm.p[k - dk]) {
          kk = k - dk;
          break;
        }
        if (arm.p[k + dk]) {
          kk = k + dk;
          break;
        }
      }
      const cp = arm.p[kk],
        tg = arm.t[kk];
      if (cp && tg) {
        d.subVectors(v, cp);
        const al = d.dot(tg);
        q.copy(d).addScaledVector(tg, -al);
        const rl = Math.max(1e-5, q.length());
        q.divideScalar(rl);
        const along = alongArm(pt, v);
        const t = clamp01(along / Math.max(reach, 0.05));
        const offM = toM(armEase) * (1 + 0.5 * loose * t) + thick;
        out = cp
          .clone()
          .addScaledVector(tg, al)
          .addScaledVector(q, rl + offM);
        c = spec.sleeve === 'none' ? OUT : reach - along;
        trim = reach - along;
        zone =
          spec.sleeve === 'long' && armDim && along > reach * 0.82
            ? 'arm_length'
            : dims.has('chest')
              ? 'chest'
              : 'waist';
        sleeveUV(i, pt, v, along);
        seamV[i] = Math.max(outsideArmhole(pt, v) - 0.004 * s, 0.002);
      }
    } else if ((pt === 'legL' || pt === 'legR') && spec.legs !== 'none') {
      const lg = legG[pt];
      const k = bandOf(v.y);
      let kk = k;
      while (kk < nb - 1 && !lg[kk]) kk++;
      const cc = b.legs[pt].c[kk];
      const gr = lg[kk];
      if (cc && gr) {
        const lth = Math.atan2(v.z - cc[1], v.x - cc[0]);
        const ljf = jOf(lth);
        const rb = Math.hypot(v.x - cc[0], v.z - cc[1]);
        const rg = Math.max(sampleRing(gr, ljf), rb + thick);
        out = new THREE.Vector3(cc[0] + Math.cos(lth) * rg, v.y, cc[1] + Math.sin(lth) * rg);
        const atCrotch = smoothstep(crotchY - 0.05 * s, crotchY - 0.005 * s, v.y);
        if (atCrotch > 0) {
          const hug = v.clone().addScaledVector(nv, thick + 0.6 * toM(interp(legKnots, f)));
          out.lerp(hug, atCrotch);
        }
        c = v.y - hemY0;
        const S = arcTable(gr);
        UVL[i * 2] = sampleArc(S, ljf) / tileM;
        UVL[i * 2 + 1] = v.y / tileM;
        limbV[i] = 1;
        seamV[i] = 1;
        zone =
          inseam && f < hemF + 0.06
            ? 'inseam'
            : dims.has('thigh') && f > l.crotch - 0.1
              ? 'thigh'
              : dims.has('hip')
                ? 'hip'
                : 'waist';
      }
    }

    P[i * 3] = out.x;
    P[i * 3 + 1] = out.y;
    P[i * 3 + 2] = out.z;
    cov[i] = c;
    trimD[i] = trim;
    const col = input.plain ? fallback : (zoneColor.get(zone) ?? fallback);
    COL[i * 3] = col.r;
    COL[i * 3 + 1] = col.g;
    COL[i * 3 + 2] = col.b;
  }

  // Smooth normals of the cloth, ignoring faces the hull folded over.
  const N = new Float32Array(n * 3);
  const pa = new THREE.Vector3(),
    pb = new THREE.Vector3(),
    pc = new THREE.Vector3();
  const oa = new THREE.Vector3(),
    ob = new THREE.Vector3(),
    oc = new THREE.Vector3();
  const fn = new THREE.Vector3(),
    on = new THREE.Vector3(),
    e1 = new THREE.Vector3(),
    e2 = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t),
      i1 = index.getX(t + 1),
      i2 = index.getX(t + 2);
    if (cov[i0]! < -0.05 && cov[i1]! < -0.05 && cov[i2]! < -0.05) continue;
    pa.fromArray(P, i0 * 3);
    pb.fromArray(P, i1 * 3);
    pc.fromArray(P, i2 * 3);
    oa.fromBufferAttribute(pos, i0);
    ob.fromBufferAttribute(pos, i1);
    oc.fromBufferAttribute(pos, i2);
    fn.crossVectors(e1.subVectors(pb, pa), e2.subVectors(pc, pa));
    on.crossVectors(e1.subVectors(ob, oa), e2.subVectors(oc, oa));
    if (fn.dot(on) <= 0) continue;
    for (const ii of [i0, i1, i2]) {
      N[ii * 3] += fn.x;
      N[ii * 3 + 1] += fn.y;
      N[ii * 3 + 2] += fn.z;
    }
  }
  for (let i = 0; i < n; i++) {
    fn.fromArray(N, i * 3);
    if (fn.lengthSq() < 1e-14) fn.fromBufferAttribute(nrm, i);
    fn.normalize().toArray(N, i * 3);
  }

  // ── faces, clipped at hems, cuffs and neckline ──
  const cloth = new Emitter(bottom);
  const trimOut = new Emitter(bottom);
  const trimW = bottom ? 0.035 * s : 0.019 * s;
  const cuffDiffers = !!input.tex?.cuff && colourDistance(input.tex.cuff, input.tex.tone) > 45;
  const collarCol = new THREE.Color(
    bottom ? (input.tex?.waistband ?? input.color) : (input.tex?.collar ?? input.color),
  );
  if (!input.tex) collarCol.multiplyScalar(0.88); // a rib reads a shade darker
  const cuffCol = new THREE.Color(input.tex?.cuff ?? input.color);
  const wantTrim = !input.plain;
  const rec = (i: number): number[] => [
    P[i * 3]!,
    P[i * 3 + 1]!,
    P[i * 3 + 2]!,
    N[i * 3]!,
    N[i * 3 + 1]!,
    N[i * 3 + 2]!,
    UV[i * 2]!,
    UV[i * 2 + 1]!,
    UVL[i * 2]!,
    UVL[i * 2 + 1]!,
    COL[i * 3]!,
    COL[i * 3 + 1]!,
    COL[i * 3 + 2]!,
    cov[i]!,
    trimD[i]!,
    seamV[i]!,
  ];
  const emitPart = (poly: number[][], limb: boolean) => {
    if (poly.length < 3) return;
    const isSleeve = limb && !bottom;
    const trimHere = wantTrim && (!isSleeve || cuffDiffers);
    if (!trimHere) {
      cloth.add(poly, limb);
      return;
    }
    const main = clipPoly(poly, (r) => r[R.trim]! - trimW);
    if (main.length >= 3) cloth.add(main, limb);
    const band = clipPoly(poly, (r) => trimW - r[R.trim]!);
    if (band.length >= 3) trimOut.add(band, limb, (bottom ? 0.0015 : 0.003) * s, isSleeve ? cuffCol : collarCol, trimW);
  };
  for (let t = 0; t < index.count; t += 3) {
    const ids = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (ids.every((i) => cov[i]! < 0)) continue;
    {
      // The hull can fold a face over (under a belly, at the crotch): turn it
      // to face out, or it renders as a dark sliver.
      const [i0, i1, i2] = ids as [number, number, number];
      pa.fromArray(P, i0 * 3);
      pb.fromArray(P, i1 * 3);
      pc.fromArray(P, i2 * 3);
      oa.fromBufferAttribute(pos, i0);
      ob.fromBufferAttribute(pos, i1);
      oc.fromBufferAttribute(pos, i2);
      fn.crossVectors(e1.subVectors(pb, pa), e2.subVectors(pc, pa));
      on.crossVectors(e1.subVectors(ob, oa), e2.subVectors(oc, oa));
      if (fn.dot(on) < 0) ids.reverse();
    }
    const poly = clipPoly(ids.map(rec), (r) => r[R.cov]!);
    if (poly.length < 3) continue;
    const sv = ids.map((i) => seamV[i]!);
    if (sv.every((x) => x < 0)) emitPart(poly, false);
    else if (sv.every((x) => x >= 0)) emitPart(poly, true);
    else if (bottom) emitPart(poly, sv.filter((x) => x >= 0).length >= 2);
    else {
      emitPart(
        clipPoly(poly, (r) => -r[R.seam]!),
        false,
      );
      emitPart(
        clipPoly(poly, (r) => r[R.seam]!),
        true,
      );
    }
  }

  // ── the hang below the hip (kurtas, coats, dresses, skirts) ──
  if ((spec.drape || hangs) && hemF < drapeF) {
    const kStart = bandOf(y0 + drapeF * H);
    const kEnd = Math.max(0, Math.floor(hemF * nb));
    const flare = spec.flare * Math.sqrt(cut) * (H / nb);
    let ring: Float64Array | null = G[nearestK(clamp(kStart, kBot, kTop))];
    const rings: { y: number; r: Float64Array; S: Float64Array }[] = [];
    for (let k = kStart; k >= kEnd; k--) {
      const tr = b.trunk[k];
      const y = k === kEnd ? hemY0 : k === kStart ? y0 + drapeF * H : y0 + ((k + 0.5) / nb) * H;
      const offk = toM(interp(torsoKnots, (k + 0.5) / nb)) + thick;
      const under = input.over?.[k];
      const base = tr ? tr.map((r, j) => Math.max(r + offk + layer, under ? under[j]! + 0.005 * s : 0)) : ring!;
      const step2 = (k + 0.5) / nb < l.hip ? flare : 0;
      let next: Float64Array = ring ? base.map((r, j) => Math.max(r, ring![j]! + step2)) : base;
      next = smoothRing(next, 2).map((r, j) => Math.max(r, ring ? ring[j]! : 0));
      ring = next;
      rings.push({ y, r: next, S: arcTable(next) });
    }
    // Cloth hanging free folds, more toward the hem and the looser it is.
    rings.forEach((rg, idx) => {
      const t = idx / Math.max(1, rings.length - 1);
      const amp = (0.003 + 0.007 * loose + 0.03 * spec.flare) * s * t;
      rg.r = rg.r.map((r, j) => {
        const th = angleOf(j);
        return r + amp * (0.5 + 0.5 * Math.sin(11 * th + 0.7 + 0.6 * Math.sin(4 * th)));
      });
      rg.S = arcTable(rg.r);
    });
    const zoneAt = (y: number) => zoneColor.get(nearestZone((y - y0) / H, l, dims, ['waist', 'hip'])) ?? fallback;
    const vert = (rg: (typeof rings)[number], j: number): number[] => {
      const th = angleOf(j);
      const r = rg.r[j % NA]!;
      const u = bottom ? rg.S[j]! / tileM : uRound(0, j % NA);
      const col = input.plain ? fallback : zoneAt(rg.y);
      const vv = bottom ? rg.y / tileM : panelV(rg.y);
      return [
        b.ax + Math.cos(th) * r,
        rg.y,
        b.az + Math.sin(th) * r,
        0,
        0,
        0,
        u,
        vv,
        u,
        vv,
        col.r,
        col.g,
        col.b,
        1,
        1e3,
        -1,
      ];
    };
    const ptAt = (k: number, j: number) => {
      const rg = rings[clamp(k, 0, rings.length - 1)]!;
      const jj = ((j % NA) + NA) % NA;
      const th = angleOf(jj);
      return new THREE.Vector3(b.ax + Math.cos(th) * rg.r[jj]!, rg.y, b.az + Math.sin(th) * rg.r[jj]!);
    };
    const normalAt = (k: number, j: number) => {
      const ta = ptAt(k, j + 1).sub(ptAt(k, j - 1));
      const td = ptAt(k + 1, j).sub(ptAt(k - 1, j));
      const nn = new THREE.Vector3().crossVectors(ta, td).normalize();
      const th = angleOf(((j % NA) + NA) % NA);
      if (nn.x * Math.cos(th) + nn.z * Math.sin(th) < 0) nn.negate();
      return nn;
    };
    for (let k = 0; k + 1 < rings.length; k++) {
      for (let j = 0; j < NA; j++) {
        const a0 = vert(rings[k]!, j),
          a1 = vert(rings[k]!, j + 1);
        const b0 = vert(rings[k + 1]!, j),
          b1 = vert(rings[k + 1]!, j + 1);
        // Smooth normals from the neighbouring ring points (outwards).
        const corners: [number[], number, number][] = [
          [a0, k, j],
          [a1, k, j + 1],
          [b0, k + 1, j],
          [b1, k + 1, j + 1],
        ];
        for (const [r, kk, jj] of corners) {
          const nn = normalAt(kk, jj);
          r[3] = nn.x;
          r[4] = nn.y;
          r[5] = nn.z;
        }
        cloth.add([a0, b1, b0], false);
        cloth.add([a0, a1, b1], false);
      }
    }
  }

  // ── zone tags (fit map) ──
  const tags = input.plain ? [] : makeTags(b, dims, spec, topF, hemF, bottom);

  return {
    cloth: cloth.geometry(),
    trim: trimOut.count ? trimOut.geometry() : null,
    tags,
    tight,
    loose,
    summary: fitSummary(tight, loose),
    hemY: hemY0,
    tiled: bottom,
    trunk: G,
  };
}

function colourDistance(a: string, b: string): number {
  const ca = new THREE.Color(a),
    cb = new THREE.Color(b);
  return 255 * (Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b));
}

/** Sutherland–Hodgman: the part of a polygon where val(record) >= 0. */
function clipPoly(poly: number[][], val: (r: number[]) => number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!,
      b = poly[(i + 1) % poly.length]!;
    const va = val(a),
      vb = val(b);
    if (va >= 0) out.push(a);
    if (va >= 0 !== vb >= 0) {
      const t = va / (va - vb);
      out.push(a.map((x, k) => x + (b[k]! - x) * t));
    }
  }
  return out;
}

class Emitter {
  private p: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  count = 0;
  constructor(private readonly tiled: boolean) {}

  /** `lift` raises a trim off the cloth: rolled (most in the middle of a
   * band `width` wide, flush at its edges) when a width is given. */
  add(poly: number[][], limb: boolean, lift = 0, color?: THREE.Color, width = 0) {
    for (let k = 1; k + 1 < poly.length; k++) {
      const tri = [poly[0]!, poly[k]!, poly[k + 1]!];
      const ui = limb ? R.ul : R.u;
      const us = tri.map((r) => r[ui]!);
      // The trunk's texture wraps at the wearer's right side seam (u 0 ≡ 1).
      if (!limb && !this.tiled && Math.max(...us) - Math.min(...us) > 0.5) {
        for (let m = 0; m < 3; m++) if (us[m]! < 0.5) us[m]! += 1;
      }
      for (let m = 0; m < 3; m++) {
        const r = tri[m]!;
        const nl = Math.hypot(r[R.nx]!, r[R.nx + 1]!, r[R.nx + 2]!) || 1;
        const nx = r[R.nx]! / nl,
          ny = r[R.nx + 1]! / nl,
          nz = r[R.nx + 2]! / nl;
        // A rib is thickest at its folded edge and flush where it is sewn on.
        const h = width > 0 ? lift * Math.cos((Math.PI / 2) * clamp01(r[R.trim]! / width)) : lift;
        this.p.push(r[R.x]! + nx * h, r[R.x + 1]! + ny * h, r[R.x + 2]! + nz * h);
        this.nrm.push(nx, ny, nz);
        this.uv.push(us[m]!, r[ui + 1]!);
        if (color) this.col.push(color.r, color.g, color.b);
        else this.col.push(r[R.r]!, r[R.r + 1]!, r[R.r + 2]!);
      }
      this.count++;
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function makeTags(
  b: BodyModel,
  dims: Map<string, FitDimension>,
  spec: (typeof SPECS)[Kind],
  top: number,
  hem: number,
  bottom: boolean,
): ZoneTag[] {
  const { y0, H, nb, bands, cx, s } = b;
  const tags: ZoneTag[] = [];
  const front = b.front + 0.02;
  const tagAt = (name: string, f: number, x: number) => {
    const d = dims.get(name);
    if (!d) return;
    const isLength = name === 'arm_length' || name === 'inseam';
    const [lo, hi] = d.range;
    const outside = d.outsideCm ?? (d.body > hi ? d.body - hi : d.body < lo ? d.body - lo : 0);
    tags.push({
      name,
      label: d.label,
      verdict: d.verdict,
      deltaCm: Math.round(outside * 10) / 10,
      isLength,
      unsure: isUnsure(d),
      position: new THREE.Vector3(x, y0 + f * H, front),
      color: isUnsure(d) ? FIT_COLORS.unsure : verdictColor(d.verdict),
    });
  };
  const bodyRight = (f: number) => {
    const k = clamp(Math.floor(f * nb), 0, nb - 1);
    const cls = bands[k]!.filter((cl) => cl.part === 'torso' || cl.part === 'legR');
    const edge = cls.length ? Math.max(...cls.map((cl) => cl.max)) : cx + 0.15 * s;
    return edge + 0.06 * s;
  };
  const l = b.l;
  const left = cx - 0.45 * s;
  if (!bottom) {
    if (top >= l.chest) tagAt('chest', l.chest, bodyRight(l.chest));
    if (top >= l.chest) tagAt('shoulder_width', l.shoulder, bodyRight(l.shoulder));
  }
  if (top >= l.waist && (hem <= l.waist || spec.drape)) tagAt('waist', l.waist, bodyRight(l.waist));
  if (hem <= l.hip || spec.drape || spec.legs !== 'none') tagAt('hip', l.hip, bodyRight(l.hip));
  if (spec.legs !== 'none') tagAt('thigh', l.thigh, bodyRight(l.thigh));
  if (spec.legs === 'long') tagAt('inseam', Math.max(hem, 0.05) + 0.04, left);
  if (spec.sleeve === 'long') tagAt('arm_length', l.hip, left);

  const gapY = 0.05 * H;
  for (const side of [(t: ZoneTag) => t.position.x >= cx, (t: ZoneTag) => t.position.x < cx]) {
    const col = tags.filter(side).sort((p, q) => q.position.y - p.position.y);
    for (let i = 1; i < col.length; i++) {
      const above = col[i - 1]!.position.y;
      if (above - col[i]!.position.y < gapY) col[i]!.position.y = above - gapY;
    }
  }
  return tags;
}
