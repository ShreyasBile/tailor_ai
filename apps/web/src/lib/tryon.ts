/**
 * Virtual try-on geometry: wraps a garment around the user's own body mesh.
 *
 * The garment is a shell offset from the body by its *ease* — garment
 * circumference minus body circumference — at every height. Ease comes from
 * the fit engine's per-dimension result for the chosen size (how far the body
 * sits from that size's ideal) plus the design ease a garment of this kind and
 * cut is made with. Where ease runs out the shell hugs the body and the zone
 * turns red; where there is plenty it floats and turns blue. Skirts, dresses,
 * kurtas and coats hang as a tube below the hip instead of following the legs.
 *
 * Deliberately geometric (no cloth simulation): it shows the truth about fit,
 * from the same numbers as the size recommendation, at interactive speed.
 */

import * as THREE from 'three';
import type { Kind } from '@/components/garment-art';
import type { FitDimension } from '@/lib/types';

export type Part = 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'hand';

export interface Landmarks {
  /** Fractions of stature from the ground. */
  neck: number;
  shoulder: number;
  chest: number;
  waist: number;
  hip: number;
  crotch: number;
  thigh: number;
}

export const DEFAULT_LANDMARKS: Landmarks = {
  neck: 0.85,
  shoulder: 0.82,
  chest: 0.72,
  waist: 0.63,
  hip: 0.53,
  crotch: 0.47,
  thigh: 0.44,
};

export type Sleeve = 'none' | 'short' | 'elbow' | 'threeQuarter' | 'long';

export interface Spec {
  top: (l: Landmarks) => number;
  hem: (l: Landmarks) => number;
  sleeve: Sleeve;
  legs: 'none' | 'short' | 'long';
  /** Hangs from the waist, falling straight from the fullest point of belly
   * and hips, rather than following the legs. */
  drape: boolean;
  /** Extra radius (fraction of stature) per unit of stature below the hip. */
  flare: number;
  /** Design ease (cm) at chest / waist / hip for a regular cut. */
  ease: { chest: number; waist: number; hip: number; thigh: number };
}

export const topNeck = (l: Landmarks) => l.neck - 0.012;
export const SPECS: Record<Kind, Spec> = {
  tee: { top: topNeck, hem: (l) => l.hip - 0.03, sleeve: 'short', legs: 'none', drape: false, flare: 0, ease: { chest: 9, waist: 10, hip: 9, thigh: 0 } },
  polo: { top: topNeck, hem: (l) => l.hip - 0.035, sleeve: 'short', legs: 'none', drape: false, flare: 0, ease: { chest: 10, waist: 11, hip: 10, thigh: 0 } },
  shirt: { top: topNeck, hem: (l) => l.hip - 0.06, sleeve: 'long', legs: 'none', drape: false, flare: 0, ease: { chest: 11, waist: 12, hip: 10, thigh: 0 } },
  knit: { top: topNeck, hem: (l) => l.hip - 0.02, sleeve: 'long', legs: 'none', drape: false, flare: 0, ease: { chest: 6, waist: 7, hip: 6, thigh: 0 } },
  hoodie: { top: topNeck, hem: (l) => l.hip - 0.03, sleeve: 'long', legs: 'none', drape: false, flare: 0, ease: { chest: 15, waist: 16, hip: 12, thigh: 0 } },
  kurta: { top: topNeck, hem: () => 0.3, sleeve: 'long', legs: 'none', drape: true, flare: 0.05, ease: { chest: 12, waist: 14, hip: 14, thigh: 0 } },
  blazer: { top: topNeck, hem: (l) => l.hip - 0.07, sleeve: 'long', legs: 'none', drape: false, flare: 0, ease: { chest: 11, waist: 12, hip: 10, thigh: 0 } },
  jacket: { top: topNeck, hem: (l) => l.hip - 0.03, sleeve: 'long', legs: 'none', drape: false, flare: 0, ease: { chest: 16, waist: 18, hip: 14, thigh: 0 } },
  vest: { top: topNeck, hem: (l) => l.hip - 0.02, sleeve: 'none', legs: 'none', drape: false, flare: 0, ease: { chest: 8, waist: 9, hip: 8, thigh: 0 } },
  coat: { top: topNeck, hem: () => 0.29, sleeve: 'long', legs: 'none', drape: true, flare: 0.04, ease: { chest: 18, waist: 20, hip: 18, thigh: 0 } },
  jeans: { top: (l) => l.waist, hem: () => 0.02, sleeve: 'none', legs: 'long', drape: false, flare: 0, ease: { chest: 0, waist: 1.5, hip: 5, thigh: 6 } },
  trousers: { top: (l) => l.waist, hem: () => 0.02, sleeve: 'none', legs: 'long', drape: false, flare: 0, ease: { chest: 0, waist: 2, hip: 7, thigh: 8 } },
  joggers: { top: (l) => l.waist, hem: () => 0.03, sleeve: 'none', legs: 'long', drape: false, flare: 0, ease: { chest: 0, waist: 2, hip: 8, thigh: 9 } },
  shorts: { top: (l) => l.waist, hem: (l) => l.crotch - 0.12, sleeve: 'none', legs: 'short', drape: false, flare: 0, ease: { chest: 0, waist: 2, hip: 7, thigh: 10 } },
  skirt: { top: (l) => l.waist, hem: () => 0.24, sleeve: 'none', legs: 'none', drape: true, flare: 0.14, ease: { chest: 0, waist: 2, hip: 8, thigh: 0 } },
  dress: { top: topNeck, hem: () => 0.24, sleeve: 'none', legs: 'none', drape: true, flare: 0.1, ease: { chest: 8, waist: 8, hip: 10, thigh: 0 } },
};

export const CUT_MULT: Record<string, number> = { SLIM: 0.6, REGULAR: 1.0, RELAXED: 1.5, OVERSIZED: 2.2 };
export const SLEEVE_FRAC: Record<Sleeve, number> = { none: 0, short: 0.32, elbow: 0.5, threeQuarter: 0.72, long: 1 };

export interface TryOnInput {
  geometry: THREE.BufferGeometry; // welded body, world frame, metres, Y-up, grounded
  kind: Kind;
  category: string;
  fitIntent: string;
  dims: FitDimension[];
  landmarks: Landmarks;
  /** Body lengths (cm) when known, for sleeve and trouser-hem placement. */
  armLengthCm?: number;
  inseamCm?: number;
}

export interface ZoneTag {
  name: string;
  label: string;
  verdict: string;
  /** Distance from the size's range: + garment too small/short, − too big/long, 0 fits. */
  deltaCm: number;
  isLength: boolean;
  /** The body measurement behind this verdict is low-confidence. */
  unsure: boolean;
  position: THREE.Vector3;
  color: string;
}

export interface TryOnResult {
  garment: THREE.BufferGeometry;
  tags: ZoneTag[];
  hemY: number;
}

// ── fit colours ──

export const FIT_COLORS = {
  tight: '#d64545',
  snug: '#e2a336',
  good: '#3f9d6b',
  relaxed: '#7bbf9a',
  loose: '#5b9bd5',
  veryLoose: '#2f6fb5',
  unsure: '#a3a7ad',
} as const;

/** The scan doubts this measurement (e.g. a thigh read through loose
 * trousers): show the zone as unknown rather than paint a verdict as fact. */
export const UNSURE_BELOW = 0.3;
export const isUnsure = (d: FitDimension) => d.confidence !== undefined && d.confidence < UNSURE_BELOW;

export function verdictColor(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v.includes('too tight') || v.includes('too short')) return FIT_COLORS.tight;
  if (v.includes('snug') || v.includes('slightly')) return FIT_COLORS.snug;
  if (v.includes('good')) return FIT_COLORS.good;
  if (v === 'relaxed') return FIT_COLORS.relaxed;
  if (v.includes('too loose') || v.includes('too long')) return FIT_COLORS.veryLoose;
  if (v.includes('loose')) return FIT_COLORS.loose;
  return FIT_COLORS.good;
}

// ── body segmentation ──

export interface Cluster {
  min: number;
  max: number;
  part: Part;
}

/** Splits the body into torso / arms / legs / hands by slicing it into
 * horizontal bands and labelling the blobs in each band. Needs a pose with
 * the arms held off the torso (the scan's A-pose). */
export function segment(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, y0: number, H: number, cx: number, l: Landmarks) {
  const nb = 140;
  const bands: number[][] = Array.from({ length: nb }, () => []);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = [a, b, c];
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i));
    b.fromBufferAttribute(pos, index.getX(i + 1));
    c.fromBufferAttribute(pos, index.getX(i + 2));
    const lo = Math.min(a.y, b.y, c.y), hi = Math.max(a.y, b.y, c.y);
    const k0 = Math.max(0, Math.ceil(((lo - y0) / H) * nb - 0.5));
    const k1 = Math.min(nb - 1, Math.floor(((hi - y0) / H) * nb - 0.5));
    for (let k = k0; k <= k1; k++) {
      const y = y0 + ((k + 0.5) / nb) * H;
      const cut: number[] = [];
      for (let e = 0; e < 3; e++) {
        const p = tri[e]!, q = tri[(e + 1) % 3]!;
        if ((p.y - y) * (q.y - y) < 0) cut.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
      }
      // Sample along the cut segment so the outline is dense: gaps between
      // samples then only appear between separate limbs, never across a
      // coarse face of the torso.
      if (cut.length === 2) {
        for (let j = 0; j <= 6; j++) bands[k]!.push(cut[0]! + ((cut[1]! - cut[0]!) * j) / 6);
      }
    }
  }

  const gap = 0.012 * (H / 1.75);
  const clustered = bands.map((xs) => {
    const out: Cluster[] = [];
    if (xs.length < 2) return out;
    xs.sort((p, q) => p - q);
    let start = xs[0]!;
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i]! - xs[i - 1]! > gap) {
        out.push({ min: start, max: xs[i - 1]!, part: 'torso' });
        if (i < xs.length) start = xs[i]!;
      }
    }
    return out;
  });
  const spans = (cls: Cluster[]) => cls.find((cl) => cl.min <= cx && cx <= cl.max);

  // The crotch, from the geometry: the highest band below the hip where
  // nothing crosses the midline. The scan's estimate is the fallback.
  let crotchY = l.crotch;
  for (let k = Math.floor(0.6 * nb); k > Math.floor(0.3 * nb); k--) {
    if (clustered[k]!.length > 0 && !spans(clustered[k]!)) {
      crotchY = (k + 1) / nb;
      break;
    }
  }

  const labelled = clustered.map((out, k) => {
    if (out.length === 0) return out;
    const frac = (k + 0.5) / nb;
    const mid = (cl: Cluster) => (cl.min + cl.max) / 2;
    const containing = spans(out);
    if (frac >= crotchY) {
      const torso = containing ?? out.reduce((p, q) => (Math.abs(mid(p) - cx) < Math.abs(mid(q) - cx) ? p : q));
      for (const cl of out) cl.part = cl === torso ? 'torso' : mid(cl) < cx ? 'armL' : 'armR';
    } else {
      // Just below the crotch the legs can still be one blob spanning the
      // midline: that is pelvis, not a leg. Legs are the blobs nearest the
      // midline on each side; hands hang further out.
      const reach = 0.2 * (H / 1.75);
      const near = (cl: Cluster) => Math.min(Math.abs(cl.min - cx), Math.abs(cl.max - cx)) < reach;
      const left = out.filter((cl) => cl !== containing && cl.max < cx && near(cl));
      const right = out.filter((cl) => cl !== containing && cl.min > cx && near(cl));
      const legL = left[left.length - 1];
      const legR = right[0];
      for (const cl of out) {
        cl.part = cl === containing ? 'torso' : cl === legL ? 'legL' : cl === legR ? 'legR' : 'hand';
      }
    }
    return out;
  });
  return { bands: labelled, crotch: crotchY };
}

// ── ease along the body ──

export function dimMap(dims: FitDimension[]) {
  const m = new Map<string, FitDimension>();
  for (const d of dims) m.set(d.name, d);
  return m;
}

/** Piecewise-linear interpolation over (height, value) knots. */
export function interp(knots: [number, number][], y: number): number {
  const ks = [...knots].sort((p, q) => p[0] - q[0]);
  if (ks.length === 0) return 0;
  if (y <= ks[0]![0]) return ks[0]![1];
  for (let i = 1; i < ks.length; i++) {
    const [y1, v1] = ks[i]!;
    const [y0, v0] = ks[i - 1]!;
    if (y <= y1) return v0 + ((v1 - v0) * (y - y0)) / Math.max(1e-6, y1 - y0);
  }
  return ks[ks.length - 1]![1];
}

export function buildTryOn(input: TryOnInput): TryOnResult {
  const { geometry, kind, fitIntent } = input;
  const spec = SPECS[kind];
  const cut = CUT_MULT[fitIntent] ?? 1;
  const dims = dimMap(input.dims);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const index = geometry.getIndex()!;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const y0 = box.min.y;
  const H = box.max.y - box.min.y;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const s = H / 1.75; // stature scale for metric constants

  const seg = segment(pos, index, y0, H, cx, input.landmarks);
  const bands = seg.bands;
  const nb = bands.length;
  // Landmarks on *this* mesh: the crotch as measured from its geometry.
  const l: Landmarks = { ...input.landmarks, crotch: seg.crotch };
  const partOf = (x: number, y: number): Part => {
    const k0 = Math.min(nb - 1, Math.max(0, Math.floor(((y - y0) / H) * nb)));
    // Extremities (fingertips, a hem of skin) can sit between two slices;
    // look one or two bands either side before guessing.
    let best: Cluster | null = null, bestD = Infinity;
    for (const dk of [0, -1, 1, -2, 2]) {
      const cls = bands[k0 + dk];
      if (!cls) continue;
      for (const cl of cls) {
        const d = x < cl.min ? cl.min - x : x > cl.max ? x - cl.max : 0;
        if (d < bestD - 1e-9) { bestD = d; best = cl; }
      }
      if (bestD < 0.004 * s) break;
    }
    if (!best) return 'torso';
    // Far from every slice: a stray extremity — never a garment region.
    return bestD > 0.03 * s ? 'hand' : best.part;
  };

  // Ease (cm) per zone: the garment's design ease for this kind and cut, less
  // however far the body is outside this size's range — the same number the
  // fit engine reports — so a zone it calls too small hugs the body and one it
  // calls too big hangs off it. Older results without outsideCm use roomCm.
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
  const legKnots: [number, number][] = [
    [l.crotch - 0.02, easeThigh],
    [0.28, easeThigh * (kind === 'jeans' ? 0.75 : 0.8)],
    [0.06, easeThigh * (kind === 'joggers' ? 0.15 : 0.7)],
  ];

  const top = spec.top(l);
  let hem = spec.hem(l);
  // Trouser hem from the size's inseam: crotch height minus garment inseam.
  const inseam = dims.get('inseam');
  if (spec.legs === 'long' && inseam) {
    const garmentInseam = (inseam.range[0] + inseam.range[1]) / 2;
    hem = Math.max(0.008, l.crotch - garmentInseam / (H * 100));
  }
  const drapeStart = spec.drape ? l.waist : -1;

  // Sleeve reach (metres from the shoulder point along the arm).
  const armLen = (input.armLengthCm ?? 0.27 * H * 100) / 100;
  const armDim = dims.get('arm_length');
  const garmentArm = armDim ? (armDim.range[0] + armDim.range[1]) / 200 : armLen;
  const sleeveReach = spec.sleeve === 'long' ? garmentArm : SLEEVE_FRAC[spec.sleeve] * armLen;

  // Shoulder points: torso edge at shoulder height.
  const kS = Math.min(nb - 1, Math.floor(l.shoulder * nb));
  const torsoAtShoulder = bands[kS]!.find((cl) => cl.part === 'torso');
  const shoulderL = new THREE.Vector3(torsoAtShoulder?.min ?? cx - 0.18 * s, y0 + l.shoulder * H, cz);
  const shoulderR = new THREE.Vector3(torsoAtShoulder?.max ?? cx + 0.18 * s, y0 + l.shoulder * H, cz);

  // ── per-vertex offset, zone and coverage ──
  // `cover` is a signed distance (m) inside the garment's coverage: positive
  // inside, negative outside. Faces are clipped where it crosses zero, so hems,
  // cuffs and the neckline are clean cuts rather than a saw-tooth of whole
  // triangles.
  const n = pos.count;
  const cover = new Float32Array(n);
  const offset = new Float32Array(n);
  const zone = new Array<string>(n);
  const thickness = 0.003 * s;
  const OUTSIDE = -0.02;
  const v = new THREE.Vector3();
  const toM = (easeCm: number) => Math.max(easeCm, 0) / (2 * Math.PI) / 100;
  // A hanging garment's top part reaches a little below where the hang
  // starts, so the two overlap instead of showing a band of skin.
  const torsoLow = spec.drape ? Math.max(hem, drapeStart - 0.012) : hem;

  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const f = (v.y - y0) / H;
    const part = partOf(v.x, v.y);
    if (part === 'torso') {
      offset[i] = toM(interp(torsoKnots, f)) + thickness;
      zone[i] = f > (l.chest + l.shoulder) / 2 && dims.has('shoulder_width') ? 'shoulder_width'
        : nearestZone(f, l, dims, ['chest', 'waist', 'hip']);
      cover[i] = Math.min(f - torsoLow, top - f) * H;
    } else if (part === 'armL' || part === 'armR') {
      const d = v.distanceTo(part === 'armL' ? shoulderL : shoulderR);
      const taper = 1 - 0.45 * Math.min(1, d / Math.max(armLen, 1e-3));
      offset[i] = toM((easeChest * 0.35 + 3) * taper) + thickness;
      zone[i] = spec.sleeve === 'long' && armDim && d > sleeveReach * 0.82 ? 'arm_length' : dims.has('chest') ? 'chest' : 'waist';
      cover[i] = spec.sleeve === 'none' ? OUTSIDE : sleeveReach - d;
    } else if (part === 'legL' || part === 'legR') {
      offset[i] = toM(interp(legKnots, f)) + thickness;
      zone[i] = inseam && f < hem + 0.06 ? 'inseam' : dims.has('thigh') && f > l.crotch - 0.1 ? 'thigh' : dims.has('hip') ? 'hip' : 'waist';
      cover[i] = spec.legs === 'none' ? OUTSIDE : (f - hem) * H;
    } else {
      offset[i] = thickness;
      zone[i] = '';
      cover[i] = OUTSIDE;
    }
  }

  // ── shell faces, clipped at the coverage boundary ──
  const positions: number[] = [];
  const colors: number[] = [];
  const zoneColor = new Map<string, THREE.Color>();
  for (const [name, d] of dims) zoneColor.set(name, new THREE.Color(isUnsure(d) ? FIT_COLORS.unsure : verdictColor(d.verdict)));
  const fallback = new THREE.Color(FIT_COLORS.good);
  type Vtx = [number, number, number, number, number, number]; // x y z r g b
  const vtx = (i: number): Vtx => {
    v.fromBufferAttribute(pos, i);
    const o = offset[i]!;
    const c = zoneColor.get(zone[i] ?? '') ?? fallback;
    return [v.x + nrm.getX(i) * o, v.y + nrm.getY(i) * o, v.z + nrm.getZ(i) * o, c.r, c.g, c.b];
  };
  const lerp = (a: Vtx, b: Vtx, t: number): Vtx => a.map((x, k) => x + (b[k]! - x) * t) as Vtx;
  const emit = (p: Vtx) => {
    positions.push(p[0], p[1], p[2]);
    colors.push(p[3], p[4], p[5]);
  };
  for (let t = 0; t < index.count; t += 3) {
    const ids = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    const sv = ids.map((i) => cover[i]!);
    if (sv.every((x) => x < 0)) continue;
    const vs = ids.map(vtx);
    if (sv.every((x) => x >= 0)) {
      vs.forEach(emit);
      continue;
    }
    const poly: Vtx[] = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if (sv[a]! >= 0) poly.push(vs[a]!);
      if (sv[a]! >= 0 !== sv[b]! >= 0) poly.push(lerp(vs[a]!, vs[b]!, sv[a]! / (sv[a]! - sv[b]!)));
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      emit(poly[0]!);
      emit(poly[k]!);
      emit(poly[k + 1]!);
    }
  }

  // ── the hang (skirts, dresses, kurtas, coats) ──
  // Built from the body's own outline: at each height, in each direction
  // round the body, the fabric sits just outside the furthest point of hip or
  // leg — and never moves back in, as fabric falls from the widest point.
  if (spec.drape && hem < drapeStart) {
    const bins = 64;
    const rows = 28;
    const outline = (f: number): [number, number][] =>
      sectionPoints(pos, index, y0 + f * H).filter(([px]) => {
        const part = partOf(px, y0 + f * H);
        return part !== 'hand' && part !== 'armL' && part !== 'armR';
      });
    const top0 = outline(drapeStart);
    if (top0.length > 3) {
      const xs = top0.map((p) => p[0]), zs = top0.map((p) => p[1]);
      const ocx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const ocz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const polar = (pts: [number, number][]): Float64Array => {
        const r = new Float64Array(bins).fill(-1);
        for (const [px, pz] of pts) {
          const j = Math.floor(((Math.atan2(pz - ocz, px - ocx) + Math.PI) / (2 * Math.PI)) * bins) % bins;
          r[j] = Math.max(r[j]!, Math.hypot(px - ocx, pz - ocz));
        }
        // Directions with no surface (e.g. between the legs) span across.
        const known = [...r.keys()].filter((j) => r[j]! >= 0);
        if (known.length === 0) return r.fill(0);
        for (let j = 0; j < bins; j++) {
          if (r[j]! >= 0) continue;
          let a = j, b = j;
          while (r[(a + bins) % bins]! < 0) a--;
          while (r[b % bins]! < 0) b++;
          const ra = r[(a + bins) % bins]!, rb = r[b % bins]!;
          r[j] = ra + ((rb - ra) * (j - a)) / (b - a);
        }
        return r;
      };
      const smooth = (r: Float64Array): Float64Array => {
        let cur = r;
        for (let pass = 0; pass < 2; pass++) {
          const nxt = new Float64Array(bins);
          for (let j = 0; j < bins; j++) {
            nxt[j] = 0.25 * cur[(j + bins - 1) % bins]! + 0.5 * cur[j]! + 0.25 * cur[(j + 1) % bins]!;
          }
          cur = nxt;
        }
        return cur;
      };
      const dropPerRow = (drapeStart - hem) / rows;
      // Flare opens below the hip; above it the fabric only clears the body.
      const flareStep = spec.flare * Math.sqrt(cut) * dropPerRow * H;
      // Same distance off the body as the top part at the join.
      const startOff = toM(interp(torsoKnots, drapeStart)) + thickness;
      let radii = smooth(polar(top0)).map((x) => x + startOff);
      const ring = (f: number, r: Float64Array): THREE.Vector3[] =>
        [...r].map((rad, j) => {
          const th = -Math.PI + ((j + 0.5) / bins) * 2 * Math.PI;
          return new THREE.Vector3(ocx + Math.cos(th) * rad, y0 + f * H, ocz + Math.sin(th) * rad);
        });
      let prev = ring(drapeStart, radii);
      for (let row = 1; row <= rows; row++) {
        const f = drapeStart - row * dropPerRow;
        const body = polar(outline(f));
        const step = f < l.hip ? flareStep : 0;
        const off = toM(interp(torsoKnots, f)) + thickness;
        let next = radii.map((x, j) => Math.max(x + step, body[j]! + off));
        next = smooth(next).map((x, j) => Math.max(x, radii[j]!));
        const cur = ring(f, next);
        const hangColor = zoneColor.get(nearestZone(f, l, dims, ['waist', 'hip'])) ?? fallback;
        for (let j = 0; j < bins; j++) {
          const j2 = (j + 1) % bins;
          for (const p of [prev[j]!, cur[j]!, cur[j2]!, prev[j]!, cur[j2]!, prev[j2]!]) {
            positions.push(p.x, p.y, p.z);
            colors.push(hangColor.r, hangColor.g, hangColor.b);
          }
        }
        prev = cur;
        radii = next;
      }
    }
  }

  const garment = new THREE.BufferGeometry();
  garment.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  garment.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  garment.computeVertexNormals();

  // ── zone tags ──
  const tags: ZoneTag[] = [];
  const front = box.max.z + 0.02;
  const tagAt = (name: string, f: number, x: number) => {
    const d = dims.get(name);
    if (!d) return;
    const isLength = name === 'arm_length' || name === 'inseam';
    // The engine's distance from the size's range — the same number as the
    // size bars and the explanation. Older results: work it out the same way.
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
  // Girth labels sit just outside the torso (or leg) at their height — not
  // beyond the outstretched arms, where wide garments push them off-canvas.
  const bodyRight = (f: number) => {
    const k = Math.min(nb - 1, Math.max(0, Math.floor(f * nb)));
    const cls = bands[k]!.filter((cl) => cl.part === 'torso' || cl.part === 'legR');
    const edge = cls.length ? Math.max(...cls.map((cl) => cl.max)) : cx + 0.15 * s;
    return edge + 0.06 * s;
  };
  const left = box.min.x + 0.02;
  if (top >= l.chest) tagAt('chest', l.chest, bodyRight(l.chest));
  if (top >= l.chest) tagAt('shoulder_width', l.shoulder, bodyRight(l.shoulder));
  if (top >= l.waist && (hem <= l.waist || spec.drape)) tagAt('waist', l.waist, bodyRight(l.waist));
  if (hem <= l.hip || spec.drape || spec.legs !== 'none') tagAt('hip', l.hip, bodyRight(l.hip));
  if (spec.legs !== 'none') tagAt('thigh', l.thigh, bodyRight(l.thigh));
  // Lengths on the left, clear of the viewer's controls (bottom right).
  if (spec.legs === 'long') tagAt('inseam', Math.max(hem, 0.05) + 0.04, left);
  if (spec.sleeve === 'long') tagAt('arm_length', l.hip, left);

  // Labels on the same side must not overlap: walk down each side keeping a
  // label's height of clearance between neighbours.
  const gapY = 0.05 * H;
  for (const side of [(t: ZoneTag) => t.position.x >= cx, (t: ZoneTag) => t.position.x < cx]) {
    const col = tags.filter(side).sort((a, b) => b.position.y - a.position.y);
    for (let i = 1; i < col.length; i++) {
      const above = col[i - 1]!.position.y;
      if (above - col[i]!.position.y < gapY) col[i]!.position.y = above - gapY;
    }
  }

  return { garment, tags, hemY: y0 + hem * H };
}

export function nearestZone(f: number, l: Landmarks, dims: Map<string, FitDimension>, names: string[]): string {
  let best = names.find((nm) => dims.has(nm)) ?? names[0]!;
  let bestD = Infinity;
  for (const nm of names) {
    if (!dims.has(nm)) continue;
    const d = Math.abs(f - (l[nm as keyof Landmarks] ?? 0));
    if (d < bestD) { bestD = d; best = nm; }
  }
  return best;
}

/** Every point where the body's surface crosses height y, as (x, z). */
export function sectionPoints(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, y: number): [number, number][] {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = [a, b, c];
  const out: [number, number][] = [];
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i));
    b.fromBufferAttribute(pos, index.getX(i + 1));
    c.fromBufferAttribute(pos, index.getX(i + 2));
    if (Math.min(a.y, b.y, c.y) > y || Math.max(a.y, b.y, c.y) < y) continue;
    for (let e = 0; e < 3; e++) {
      const p = tri[e]!, q = tri[(e + 1) % 3]!;
      if ((p.y - y) * (q.y - y) < 0) {
        const t = (y - p.y) / (q.y - p.y);
        out.push([p.x + t * (q.x - p.x), p.z + t * (q.z - p.z)]);
      }
    }
  }
  return out;
}
