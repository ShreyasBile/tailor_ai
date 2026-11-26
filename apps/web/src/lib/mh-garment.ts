/**
 * Real 3D garments (MakeHuman community clothes, CC0) on the shopper's body.
 *
 * A MakeHuman garment is a recipe, not a fixed shape: every one of its
 * vertices is a weighted point on three vertices of the MakeHuman base mesh
 * plus an offset, scaled by the body's proportions. The shopper's 3D body
 * (Anny) is that same base mesh, so the recipe rebuilds the garment on their
 * exact body — chest, belly, shoulders and all. Most garments hang off the
 * base mesh's helper layers (tights, skirt), which come exactly from the API
 * for this body (`/me/avatar/helpers`) or, failing that, from a learned blend
 * of body vertices (`/garments/3d/helpers.json`).
 *
 * Sizes: the garment as fitted is the recommended size. Other sizes move each
 * vertex nearer to or further from the body by the difference in ease the fit
 * engine reports at that height (a size too small clings, a size too big
 * stands off and hangs), and lengthen or shorten the hem.
 *
 * Built by scripts/build-3d-garments.py from apps/api/prisma/catalog.json.
 */

import * as THREE from 'three';
import type { FitDimension } from '@/lib/types';
import { FIT_COLORS, isUnsure, verdictColor, type Landmarks } from '@/lib/tryon';

export interface MhGarment {
  slug: string;
  count: number;
  refs: Int32Array;
  weights: Float32Array;
  offsets: Float32Array;
  orig: Int32Array;
  uv: Float32Array;
  index: Uint32Array;
  hide: Int32Array;
  scale: { x: [number, number, number]; y: [number, number, number]; z: [number, number, number] };
  texture: string;
  alpha: boolean;
  color: string;
  covers: { torso: boolean; legs: boolean };
  /** A whole outfit (dress, suit): no companion piece. */
  full: boolean;
  author: string;
  license: string;
  source: string;
}

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

const garmentCache = new Map<string, Promise<MhGarment | null>>();

/** The garment's recipe, or null if this product has no 3D model. */
export function loadMhGarment(slug: string): Promise<MhGarment | null> {
  let p = garmentCache.get(slug);
  if (!p) {
    p = fetch(`/garments/3d/${slug}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) =>
        j
          ? ({
              ...j,
              refs: new Int32Array(bytes(j.refs)),
              weights: new Float32Array(bytes(j.weights)),
              offsets: new Float32Array(bytes(j.offsets)),
              orig: new Int32Array(bytes(j.orig)),
              uv: new Float32Array(bytes(j.uv)),
              index: new Uint32Array(bytes(j.index)),
              hide: new Int32Array(bytes(j.hide)),
            } as MhGarment)
          : null,
      )
      .catch(() => null);
    garmentCache.set(slug, p);
  }
  return p;
}

let regression: Promise<{ k: number; count: number; neighbours: Int32Array; weights: Float32Array } | null> | null =
  null;

/** Helper layers learned as blends of body vertices (offline fallback). */
export function helpersFromBody(body: Float32Array): Promise<Float32Array | null> {
  regression ??= fetch('/garments/3d/helpers.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) =>
      j
        ? {
            k: j.k,
            count: j.count,
            neighbours: new Int32Array(bytes(j.neighbours)),
            weights: new Float32Array(bytes(j.weights)),
          }
        : null,
    )
    .catch(() => null);
  return regression.then((reg) => {
    if (!reg) return null;
    const out = new Float32Array(reg.count * 3);
    for (let e = 0; e < reg.count; e++) {
      let x = 0,
        y = 0,
        z = 0;
      for (let k = 0; k < reg.k; k++) {
        const n = reg.neighbours[e * reg.k + k]!,
          w = reg.weights[e * reg.k + k]!;
        x += w * body[n * 3]!;
        y += w * body[n * 3 + 1]!;
        z += w * body[n * 3 + 2]!;
      }
      out[e * 3] = x;
      out[e * 3 + 1] = y;
      out[e * 3 + 2] = z;
    }
    return out;
  });
}

/** Helper layers from the API's exact positions (base64 float32). */
export function decodeHelpers(positions: string): Float32Array {
  return new Float32Array(bytes(positions));
}

/** Body vertices followed by helper vertices: what the recipes index into. */
export function extended(body: Float32Array, helpers: Float32Array): Float32Array {
  const out = new Float32Array(body.length + helpers.length);
  out.set(body, 0);
  out.set(helpers, body.length);
  return out;
}

export interface MhFitInput {
  /** This size's fit detail and the recommended size's (the garment as modelled). */
  dims: FitDimension[];
  recDims: FitDimension[];
  /** Hem change (cm, + longer) and how tight/loose overall. */
  lengthCm: number;
  landmarks: Landmarks;
  /** y of the ground and the body's height (m), for landmark heights. */
  y0: number;
  H: number;
  /** Extra standoff (m) when worn over another garment, and below which
   * height (the other garment's waistband) the cloth must clear it. */
  layer?: number;
  clearBelowY?: number;
}

export interface MhFitResult {
  geometry: THREE.BufferGeometry; // position, normal, uv, color (fit map)
  hide: Int32Array;
}

const zoneKnots = (l: Landmarks) =>
  [
    ['shoulder_width', l.shoulder],
    ['chest', l.chest],
    ['waist', l.waist],
    ['hip', l.hip],
    ['thigh', l.thigh],
  ] as const;

/** The garment on this body, in this size. */
export function fitMhGarment(ext: Float32Array, g: MhGarment, fit: MhFitInput): MhFitResult {
  const n = g.count;
  const P = new Float32Array(n * 3);
  const A = new Float32Array(n * 3); // anchor on the body / helper surface
  const axis = (k: 'x' | 'y' | 'z', c: number) => {
    const [a, b, d] = g.scale[k];
    return Math.abs(ext[a * 3 + c]! - ext[b * 3 + c]!) / (d || 1);
  };
  const sx = axis('x', 0),
    sy = axis('y', 1),
    sz = axis('z', 2);

  // Room per zone relative to the size as modelled (m of radius).
  const outside = (dims: FitDimension[], name: string) => {
    const d = dims.find((x) => x.name === name);
    if (!d) return null;
    return d.outsideCm ?? -d.roomCm;
  };
  const deltaAt = (name: string) => {
    const a = outside(fit.recDims, name),
      b = outside(fit.dims, name);
    return a === null || b === null ? null : (a - b) / (2 * Math.PI) / 100;
  };
  const knots: [number, number][] = [];
  for (const [name, f] of zoneKnots(fit.landmarks)) {
    const d = deltaAt(name === 'shoulder_width' ? 'chest' : name);
    if (d !== null) knots.push([fit.y0 + f * fit.H, d]);
  }
  knots.sort((p, q) => p[0] - q[0]);
  const deltaY = (y: number) => {
    if (!knots.length) return 0;
    if (y <= knots[0]![0]) return knots[0]![1];
    for (let i = 1; i < knots.length; i++) {
      const [y1, v1] = knots[i]!,
        [y0, v0] = knots[i - 1]!;
      if (y <= y1) return v0 + ((v1 - v0) * (y - y0)) / Math.max(1e-6, y1 - y0);
    }
    return knots[knots.length - 1]![1];
  };

  // Lowest point of the garment, for moving the hem.
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    let ay = 0;
    for (let k = 0; k < 3; k++) ay += g.weights[i * 3 + k]! * ext[g.refs[i * 3 + k]! * 3 + 1]!;
    minY = Math.min(minY, ay + g.offsets[i * 3 + 1]! * sy);
  }
  const waistY = fit.y0 + fit.landmarks.waist * fit.H;
  const bodyMidX = 0;
  const shoulderHalf = 0.2 * (fit.H / 1.75);
  const layer = fit.layer ?? 0;

  for (let i = 0; i < n; i++) {
    let ax = 0,
      ay = 0,
      az = 0;
    for (let k = 0; k < 3; k++) {
      const r = g.refs[i * 3 + k]!,
        w = g.weights[i * 3 + k]!;
      ax += w * ext[r * 3]!;
      ay += w * ext[r * 3 + 1]!;
      az += w * ext[r * 3 + 2]!;
    }
    let ox = g.offsets[i * 3]! * sx,
      oy = g.offsets[i * 3 + 1]! * sy,
      oz = g.offsets[i * 3 + 2]! * sz;
    // Size: further from (or nearer to) the body along the offset.
    const onArm = Math.abs(ax - bodyMidX) > shoulderHalf;
    const len = Math.hypot(ox, oy, oz);
    let d = deltaY(ay) * (onArm ? 0.5 : 1);
    // A smaller size pulls in the cloth that lies on the body; collars,
    // pockets and folds standing off it keep their shape.
    if (d < 0) d *= Math.min(1, Math.max(0, (0.025 - len) / 0.015));
    d += layer;
    const floor = fit.clearBelowY !== undefined && ay < fit.clearBelowY ? 0.02 : 0.0025;
    if (len > 1e-6 && (d !== 0 || len < floor)) {
      const target = Math.max(floor, len + d);
      const k = target / len;
      ox *= k;
      oy *= k;
      oz *= k;
    }
    let y = ay + oy;
    // A longer size hangs lower below the waist (a shorter one is trimmed
    // at the hem further down, rather than pushed up into the body).
    if (fit.lengthCm > 0 && y < waistY && minY < waistY) {
      const t = Math.min(1, (waistY - y) / Math.max(0.05, waistY - minY));
      y -= (fit.lengthCm / 100) * t;
    }
    A[i * 3] = ax;
    A[i * 3 + 1] = ay;
    A[i * 3 + 2] = az;
    P[i * 3] = ax + ox;
    P[i * 3 + 1] = y;
    P[i * 3 + 2] = az + oz;
  }

  // Smooth normals across UV seams (vertices sharing an original vertex).
  const maxOrig = g.orig.reduce((m, v) => Math.max(m, v), 0) + 1;
  const acc = new Float32Array(maxOrig * 3);
  const pa = new THREE.Vector3(),
    pb = new THREE.Vector3(),
    pc = new THREE.Vector3();
  const e1 = new THREE.Vector3(),
    e2 = new THREE.Vector3(),
    fn = new THREE.Vector3();
  for (let t = 0; t < g.index.length; t += 3) {
    const i0 = g.index[t]!,
      i1 = g.index[t + 1]!,
      i2 = g.index[t + 2]!;
    pa.fromArray(P, i0 * 3);
    pb.fromArray(P, i1 * 3);
    pc.fromArray(P, i2 * 3);
    fn.crossVectors(e1.subVectors(pb, pa), e2.subVectors(pc, pa));
    for (const ii of [i0, i1, i2]) {
      const o = g.orig[ii]!;
      acc[o * 3] += fn.x;
      acc[o * 3 + 1] += fn.y;
      acc[o * 3 + 2] += fn.z;
    }
  }
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = g.orig[i]!;
    fn.set(acc[o * 3]!, acc[o * 3 + 1]!, acc[o * 3 + 2]!);
    if (fn.lengthSq() < 1e-16) fn.set(0, 0, 1);
    fn.normalize().toArray(N, i * 3);
  }

  // Fit map: each zone in its verdict's colour, by height on the body.
  const colours = new Float32Array(n * 3);
  const zones = zoneKnots(fit.landmarks)
    .map(([name, f]) => ({ name, y: fit.y0 + f * fit.H, d: fit.dims.find((x) => x.name === name) }))
    .filter((z) => z.d);
  const good = new THREE.Color(FIT_COLORS.good);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const ay = A[i * 3 + 1]!;
    let best = zones[0],
      bd = Infinity;
    for (const z of zones) {
      const dd = Math.abs(z.y - ay);
      if (dd < bd) {
        bd = dd;
        best = z;
      }
    }
    if (best?.d) c.set(isUnsure(best.d) ? FIT_COLORS.unsure : verdictColor(best.d.verdict));
    else c.copy(good);
    colours[i * 3] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  if (fit.lengthCm < 0 && minY < waistY) {
    // Rides up: the hem rises by the shortfall, cut cleanly.
    const cutY = Math.min(waistY, minY - fit.lengthCm / 100);
    const out = clipBelow(cutY, P, N, g.uv, colours, g.index);
    geometry.setAttribute('position', new THREE.BufferAttribute(out.p, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(out.n, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(out.uv, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(out.c, 3));
  } else {
    geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
  }
  geometry.computeBoundingSphere();
  return { geometry, hide: g.hide };
}

/** The triangles (or parts of them) at or above height `cutY`, unindexed. */
function clipBelow(
  cutY: number,
  P: Float32Array,
  N: Float32Array,
  UV: Float32Array,
  C: Float32Array,
  index: Uint32Array,
) {
  const p: number[] = [],
    n: number[] = [],
    uv: number[] = [],
    c: number[] = [];
  type V = number[]; // x y z nx ny nz u v r g b
  const vert = (i: number): V => [
    P[i * 3]!,
    P[i * 3 + 1]!,
    P[i * 3 + 2]!,
    N[i * 3]!,
    N[i * 3 + 1]!,
    N[i * 3 + 2]!,
    UV[i * 2]!,
    UV[i * 2 + 1]!,
    C[i * 3]!,
    C[i * 3 + 1]!,
    C[i * 3 + 2]!,
  ];
  const emit = (v: V) => {
    p.push(v[0]!, v[1]!, v[2]!);
    n.push(v[3]!, v[4]!, v[5]!);
    uv.push(v[6]!, v[7]!);
    c.push(v[8]!, v[9]!, v[10]!);
  };
  for (let t = 0; t < index.length; t += 3) {
    const tri = [vert(index[t]!), vert(index[t + 1]!), vert(index[t + 2]!)];
    const d = tri.map((v) => v[1]! - cutY);
    if (d.every((x) => x < 0)) continue;
    if (d.every((x) => x >= 0)) {
      tri.forEach(emit);
      continue;
    }
    const poly: V[] = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!,
        b = tri[(e + 1) % 3]!,
        da = d[e]!,
        db = d[(e + 1) % 3]!;
      if (da >= 0) poly.push(a);
      if (da >= 0 !== db >= 0) {
        const k = da / (da - db);
        poly.push(a.map((x, j) => x + (b[j]! - x) * k));
      }
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      emit(poly[0]!);
      emit(poly[k]!);
      emit(poly[k + 1]!);
    }
  }
  return { p: new Float32Array(p), n: new Float32Array(n), uv: new Float32Array(uv), c: new Float32Array(c) };
}

/** The body's index buffer with the faces under the garments removed
 * (MakeHuman's delete_verts), so skin never shows through cloth. */
export function bodyIndexWithout(index: ArrayLike<number>, hidden: Int32Array[]): Uint32Array {
  const hide = new Set<number>();
  for (const h of hidden) for (const v of h) hide.add(v);
  const out: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]!,
      b = index[t + 1]!,
      c = index[t + 2]!;
    if (hide.has(a) || hide.has(b) || hide.has(c)) continue;
    out.push(a, b, c);
  }
  return Uint32Array.from(out);
}
