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

type Sleeve = 'none' | 'short' | 'elbow' | 'threeQuarter' | 'long';

interface Spec {
  top: (l: Landmarks) => number;
  hem: (l: Landmarks) => number;
  sleeve: Sleeve;
  legs: 'none' | 'short' | 'long';
  /** Hangs as a tube below the hip rather than following the legs. */
  drape: boolean;
  /** Extra radius (fraction of stature) per unit of stature below the hip. */
  flare: number;
  /** Design ease (cm) at chest / waist / hip for a regular cut. */
  ease: { chest: number; waist: number; hip: number; thigh: number };
}

const topNeck = (l: Landmarks) => l.neck - 0.012;
const SPECS: Record<Kind, Spec> = {
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

const CUT_MULT: Record<string, number> = { SLIM: 0.6, REGULAR: 1.0, RELAXED: 1.5, OVERSIZED: 2.2 };
const SLEEVE_FRAC: Record<Sleeve, number> = { none: 0, short: 0.32, elbow: 0.5, threeQuarter: 0.72, long: 1 };

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
  /** Ease in cm (girths) or garment-minus-body length (lengths). */
  deltaCm: number;
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
} as const;

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

interface Cluster {
  min: number;
  max: number;
  part: Part;
}

/** Splits the body into torso / arms / legs / hands by slicing it into
 * horizontal bands and labelling the blobs in each band. Needs a pose with
 * the arms held off the torso (the scan's A-pose). */
function segment(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, y0: number, H: number, cx: number, l: Landmarks) {
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

function dimMap(dims: FitDimension[]) {
  const m = new Map<string, FitDimension>();
  for (const d of dims) m.set(d.name, d);
  return m;
}

/** Piecewise-linear interpolation over (height, value) knots. */
function interp(knots: [number, number][], y: number): number {
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

  // Ease (cm) per girth dimension: design ease for this kind and cut, plus how
  // much more (or less) room than ideal the engine found for this size.
  const room = (name: string) => dims.get(name)?.roomCm ?? 0;
  const easeChest = spec.ease.chest * cut + room('chest');
  const easeWaist = spec.ease.waist * cut + room('waist');
  const easeHip = spec.ease.hip * cut + (dims.has('hip') ? room('hip') : room('waist'));
  const easeThigh = spec.ease.thigh * cut + (dims.has('thigh') ? room('thigh') : room('hip'));

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
  const drapeStart = spec.drape ? l.hip - 0.03 : -1;

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

  // ── per-vertex coverage and offset ──
  const n = pos.count;
  const covered = new Uint8Array(n);
  const offset = new Float32Array(n);
  const zone = new Array<string>(n);
  const thickness = 0.003 * s;
  const v = new THREE.Vector3();
  const toM = (easeCm: number) => Math.max(easeCm, 0) / (2 * Math.PI) / 100;

  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const f = (v.y - y0) / H;
    const part = partOf(v.x, v.y);
    if (part === 'torso') {
      if (f > top || f < Math.max(hem, drapeStart)) continue;
      covered[i] = 1;
      offset[i] = toM(interp(torsoKnots, f)) + thickness;
      zone[i] = f > (l.chest + l.shoulder) / 2 && dims.has('shoulder_width') ? 'shoulder_width'
        : nearestZone(f, l, dims, ['chest', 'waist', 'hip']);
    } else if (part === 'armL' || part === 'armR') {
      if (spec.sleeve === 'none') continue;
      const d = v.distanceTo(part === 'armL' ? shoulderL : shoulderR);
      if (d > sleeveReach) continue;
      covered[i] = 1;
      const taper = 1 - 0.45 * Math.min(1, d / Math.max(armLen, 1e-3));
      offset[i] = toM((easeChest * 0.35 + 3) * taper) + thickness;
      zone[i] = spec.sleeve === 'long' && armDim && d > sleeveReach * 0.82 ? 'arm_length' : dims.has('chest') ? 'chest' : 'waist';
    } else if (part === 'legL' || part === 'legR') {
      if (spec.legs === 'none' || f < hem) continue;
      covered[i] = 1;
      offset[i] = toM(interp(legKnots, f)) + thickness;
      zone[i] = inseam && f < hem + 0.06 ? 'inseam' : dims.has('thigh') && f > l.crotch - 0.1 ? 'thigh' : dims.has('hip') ? 'hip' : 'waist';
    }
  }

  // ── shell faces ──
  const positions: number[] = [];
  const colors: number[] = [];
  const col = new THREE.Color();
  const zoneColor = new Map<string, THREE.Color>();
  for (const [name, d] of dims) zoneColor.set(name, new THREE.Color(verdictColor(d.verdict)));
  const fallback = new THREE.Color(FIT_COLORS.good);
  const pushVertex = (i: number) => {
    v.fromBufferAttribute(pos, i);
    const o = offset[i]!;
    positions.push(v.x + nrm.getX(i) * o, v.y + nrm.getY(i) * o, v.z + nrm.getZ(i) * o);
    col.copy(zoneColor.get(zone[i] ?? '') ?? fallback);
    colors.push(col.r, col.g, col.b);
  };
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t), i1 = index.getX(t + 1), i2 = index.getX(t + 2);
    if (covered[i0] && covered[i1] && covered[i2]) {
      pushVertex(i0); pushVertex(i1); pushVertex(i2);
    }
  }

  // ── drape tube (skirts, dresses, kurtas, coats) ──
  if (spec.drape && hem < drapeStart) {
    const hipRing = sectionEllipse(pos, index, y0 + drapeStart * H, cx, cz);
    if (hipRing) {
      const seg = 48;
      const rows = 24;
      const hipColor = zoneColor.get(dims.has('hip') ? 'hip' : 'waist') ?? fallback;
      // Start a little above the torso shell's lower edge so the two overlap
      // instead of leaving a visible band of skin between them.
      const tubeTop = drapeStart + 0.035;
      const ringAt = (r: number): THREE.Vector3[] => {
        const f = tubeTop - (r / rows) * (tubeTop - hem);
        const y = y0 + f * H;
        const grow = toM(easeHip) + thickness + spec.flare * cut ** 0.5 * Math.max(0, drapeStart - f) * H;
        let rx = hipRing.rx + grow;
        let rz = hipRing.rz + grow;
        // Fuller thighs can reach past an ellipse taken at the hip: widen
        // the hang just enough to enclose the legs (never the hands).
        let k = 1;
        for (const [px, pz] of sectionPoints(pos, index, y)) {
          const part = partOf(px, y);
          if (part === 'hand' || part === 'armL' || part === 'armR') continue;
          k = Math.max(k, Math.hypot((px - hipRing.cx) / rx, (pz - hipRing.cz) / rz));
        }
        if (k > 1) {
          rx = rx * k + thickness;
          rz = rz * k + thickness;
        }
        const pts: THREE.Vector3[] = [];
        for (let j = 0; j < seg; j++) {
          const th = (j / seg) * Math.PI * 2;
          pts.push(new THREE.Vector3(hipRing.cx + Math.cos(th) * rx, y, hipRing.cz + Math.sin(th) * rz));
        }
        return pts;
      };
      let prev = ringAt(0);
      for (let r = 1; r <= rows; r++) {
        const cur = ringAt(r);
        for (let j = 0; j < seg; j++) {
          const j2 = (j + 1) % seg;
          for (const p of [prev[j]!, cur[j]!, cur[j2]!, prev[j]!, cur[j2]!, prev[j2]!]) {
            positions.push(p.x, p.y, p.z);
            colors.push(hipColor.r, hipColor.g, hipColor.b);
          }
        }
        prev = cur;
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
    const ease =
      name === 'chest' ? easeChest : name === 'waist' ? easeWaist : name === 'hip' ? easeHip : name === 'thigh' ? easeThigh : d.roomCm;
    const deltaCm = isLength ? ((d.range[0] + d.range[1]) / 2 - d.body) : ease;
    tags.push({
      name,
      label: d.label,
      verdict: d.verdict,
      deltaCm: Math.round(deltaCm * 10) / 10,
      position: new THREE.Vector3(x, y0 + f * H, front),
      color: verdictColor(d.verdict),
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

function nearestZone(f: number, l: Landmarks, dims: Map<string, FitDimension>, names: string[]): string {
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
function sectionPoints(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, y: number): [number, number][] {
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

/** Bounding ellipse of the body's central blob at height y. */
function sectionEllipse(pos: THREE.BufferAttribute, index: THREE.BufferAttribute, y: number, cx: number, cz: number) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = [a, b, c];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i));
    b.fromBufferAttribute(pos, index.getX(i + 1));
    c.fromBufferAttribute(pos, index.getX(i + 2));
    for (let e = 0; e < 3; e++) {
      const p = tri[e]!, q = tri[(e + 1) % 3]!;
      if ((p.y - y) * (q.y - y) < 0) {
        const t = (y - p.y) / (q.y - p.y);
        const x = p.x + t * (q.x - p.x);
        const z = p.z + t * (q.z - p.z);
        // Hands hang beside the hips; keep to the body's own width.
        if (Math.abs(x - cx) > 0.25) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { cx: (minX + maxX) / 2, cz: Math.max(cz - 0.2, Math.min(cz + 0.2, (minZ + maxZ) / 2)), rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2 };
}
