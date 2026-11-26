'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { api } from '@/lib/api';
import type { Kind } from '@/components/garment-art';
import { dress, type BodyModel, type DressResult } from '@/lib/garment3d';
import {
  bodyIndexWithout,
  decodeHelpers,
  extended,
  fitMhGarment,
  helpersFromBody,
  loadMhGarment,
  type MhGarment,
} from '@/lib/mh-garment';
import type { Landmarks, ZoneTag } from '@/lib/tryon';
import type { FitDimension } from '@/lib/types';

/** What else they're wearing with a top, or with trousers or a skirt. */
const COMPANION_BOTTOM = 'kinfolk-wool-trouser';
const COMPANION_TOP = 'northline-crew-tee';

const SKIN = new THREE.MeshStandardMaterial({ color: '#d2ae96', roughness: 0.62, metalness: 0 });

function useTexture(url: string | null) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!url) {
      setTex(null);
      return;
    }
    let live = true;
    new THREE.TextureLoader().load(
      url,
      (t) => {
        if (!live) return;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        setTex(t);
      },
      undefined,
      () => live && setTex(null),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return tex;
}

function clothMaterial(g: MhGarment, map: THREE.Texture | null, fitMap: boolean, faded = false) {
  if (fitMap && !faded)
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  return new THREE.MeshPhysicalMaterial({
    color: map ? '#ffffff' : g.color,
    map,
    alphaTest: g.alpha ? 0.45 : 0,
    roughness: 0.85,
    sheen: 0.45,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color('#ffffff'),
    side: THREE.DoubleSide,
    transparent: faded,
    opacity: faded ? 0.35 : 1,
  });
}

function tagText(t: ZoneTag) {
  if (t.unsure) return `${t.label}: unsure`;
  if (Math.abs(t.deltaCm) < 1) return `${t.label} fits`;
  const word = t.isLength ? (t.deltaCm > 0 ? 'too short' : 'too long') : t.deltaCm > 0 ? 'too small' : 'too big';
  return `${t.label} ${Math.abs(t.deltaCm).toFixed(0)} cm ${word}`;
}

export interface RealSceneProps {
  body: THREE.BufferGeometry; // Anny vertex order, avatar frame
  model: BodyModel;
  garment: MhGarment;
  kind: Kind;
  fitIntent: string;
  landmarks: Landmarks;
  dims: FitDimension[];
  recDims: FitDimension[];
  step: number;
  ghostDims: FitDimension[] | null;
  fitMap: boolean;
  spin: boolean;
  onResult: (r: DressResult) => void;
}

/**
 * The real garment (a MakeHuman 3D model) wrapped onto the shopper's body in
 * the chosen size, with a plain companion piece and the skin under the cloth
 * hidden.
 */
export function RealScene(p: RealSceneProps) {
  const { body, garment } = p;
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (p.spin && group.current) group.current.rotation.y += dt * 0.35;
  });
  const bodyPos = body.getAttribute('position').array as Float32Array;

  // MakeHuman's helper layers for this body: exact from the API, or learned.
  const [helpers, setHelpers] = useState<Float32Array | null>(null);
  useEffect(() => {
    let live = true;
    api<{ positions: string }>('/me/avatar/helpers')
      .then((r) => decodeHelpers(r.positions))
      .catch(() => helpersFromBody(bodyPos))
      .then((h) => {
        if (live && h) setHelpers(h);
      });
    return () => {
      live = false;
    };
  }, [bodyPos]);
  const ext = useMemo(() => (helpers ? extended(bodyPos, helpers) : null), [helpers, bodyPos]);

  const companionSlug = garment.full
    ? null
    : garment.covers.torso && !garment.covers.legs
      ? COMPANION_BOTTOM
      : !garment.covers.torso
        ? COMPANION_TOP
        : null;
  const [companion, setCompanion] = useState<MhGarment | null>(null);
  useEffect(() => {
    if (!companionSlug || companionSlug === garment.slug) {
      setCompanion(null);
      return;
    }
    let live = true;
    loadMhGarment(companionSlug).then((c) => live && setCompanion(c));
    return () => {
      live = false;
    };
  }, [companionSlug, garment.slug]);

  // Fit numbers, tags and the fit summary come from the same engine as the
  // procedural fitting room.
  const numbers = useMemo(
    () => dress(p.model, { kind: p.kind, fitIntent: p.fitIntent, dims: p.dims, step: p.step, color: garment.color }),
    [p.model, p.kind, p.fitIntent, p.dims, p.step, garment.color],
  );
  const { onResult } = p;
  useEffect(() => onResult(numbers), [numbers, onResult]);

  const frame = useMemo(() => {
    body.computeBoundingBox();
    const b = body.boundingBox!;
    return { y0: b.min.y, H: b.max.y - b.min.y };
  }, [body]);
  const topOverBottom = companionSlug === COMPANION_BOTTOM;
  const lengthCm = garment.covers.torso ? 2.2 * p.step - 6 * numbers.tight + 1.5 * numbers.loose : 0;

  const fitted = useMemo(
    () =>
      ext
        ? fitMhGarment(ext, garment, {
            dims: p.dims,
            recDims: p.recDims,
            lengthCm,
            landmarks: p.landmarks,
            y0: frame.y0,
            H: frame.H,
            layer: topOverBottom ? 0.007 : 0,
            // Over the trousers' waistband, the top keeps clear of it.
            clearBelowY: topOverBottom ? frame.y0 + (p.landmarks.waist + 0.02) * frame.H : undefined,
          })
        : null,
    [ext, garment, p.dims, p.recDims, lengthCm, p.landmarks, frame, topOverBottom],
  );
  const comp = useMemo(
    () =>
      ext && companion
        ? fitMhGarment(ext, companion, {
            dims: [],
            recDims: [],
            lengthCm: 0,
            landmarks: p.landmarks,
            y0: frame.y0,
            H: frame.H,
            layer: topOverBottom ? 0 : 0.007,
            // The plain tee over trousers or a skirt keeps clear of its waistband.
            clearBelowY: topOverBottom ? undefined : frame.y0 + (p.landmarks.waist + 0.02) * frame.H,
          })
        : null,
    [ext, companion, p.landmarks, frame, topOverBottom],
  );
  const ghost = useMemo(
    () =>
      ext && p.ghostDims
        ? fitMhGarment(ext, garment, {
            dims: p.ghostDims,
            recDims: p.recDims,
            lengthCm: 0,
            landmarks: p.landmarks,
            y0: frame.y0,
            H: frame.H,
          }).geometry
        : null,
    [ext, garment, p.ghostDims, p.recDims, p.landmarks, frame],
  );

  // The body with the skin under the cloth removed (no poke-through).
  const visibleBody = useMemo(() => {
    const idx = body.getIndex();
    if (!idx || !fitted) return body;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', body.getAttribute('position'));
    g.setAttribute('normal', body.getAttribute('normal'));
    g.setIndex(new THREE.BufferAttribute(bodyIndexWithout(idx.array, [fitted.hide, ...(comp ? [comp.hide] : [])]), 1));
    return g;
  }, [body, fitted, comp]);

  const map = useTexture(garment.texture ? `/garments/3d/${garment.texture}` : null);
  const compMap = useTexture(companion?.texture ? `/garments/3d/${companion.texture}` : null);
  const mat = useMemo(() => clothMaterial(garment, map, p.fitMap), [garment, map, p.fitMap]);
  const compMat = useMemo(
    () => (companion ? clothMaterial(companion, compMap, p.fitMap, p.fitMap) : null),
    [companion, compMap, p.fitMap],
  );
  const ghostMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#1f6f5c',
        wireframe: true,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    [],
  );

  if (!fitted) {
    return (
      <group ref={group}>
        <mesh geometry={body} material={SKIN} />
        <Html center>
          <span className="text-xs text-ink-muted">Fitting the garment to your body…</span>
        </Html>
      </group>
    );
  }
  return (
    <group ref={group}>
      <mesh geometry={visibleBody} material={SKIN} castShadow receiveShadow />
      {comp && compMat && <mesh geometry={comp.geometry} material={compMat} castShadow receiveShadow />}
      <mesh geometry={fitted.geometry} material={mat} castShadow receiveShadow />
      {ghost && <mesh geometry={ghost} material={ghostMat} />}
      {p.fitMap &&
        numbers.tags.map((t) => (
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
