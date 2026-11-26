'use client';

/**
 * Catalogue photo of a 3D garment: the garment on an invisible default body
 * (the "ghost mannequin" look), front on, on white. Used by
 * scripts/render-catalog-photos to make apps/web/public/garments/<slug>.jpg.
 *
 *   /dev/garment-shot?slug=northline-crew-tee&sex=male
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { extended, fitMhGarment, helpersFromBody, loadMhGarment, type MhGarment } from '@/lib/mh-garment';
import { DEFAULT_LANDMARKS } from '@/lib/tryon';

const b64 = (s: string) => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);

function Shot({ g, body }: { g: MhGarment; body: Float32Array }) {
  const [helpers, setHelpers] = useState<Float32Array | null>(null);
  const [map, setMap] = useState<THREE.Texture | null | undefined>(undefined);
  const { camera, gl } = useThree();
  useEffect(() => {
    helpersFromBody(body).then(setHelpers);
  }, [body]);
  useEffect(() => {
    if (!g.texture) {
      setMap(null);
      return;
    }
    new THREE.TextureLoader().load(
      `/garments/3d/${g.texture}`,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        setMap(t);
      },
      undefined,
      () => setMap(null),
    );
  }, [g]);
  const geometry = useMemo(() => {
    if (!helpers) return null;
    let y1 = -Infinity;
    for (let i = 1; i < body.length; i += 3) y1 = Math.max(y1, body[i]!);
    return fitMhGarment(extended(body, helpers), g, {
      dims: [],
      recDims: [],
      lengthCm: 0,
      landmarks: DEFAULT_LANDMARKS,
      y0: 0,
      H: y1,
    }).geometry;
  }, [helpers, body, g]);

  // Frame the garment, front on, with a margin.
  useEffect(() => {
    if (!geometry || map === undefined) return;
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    // R3F's orthographic frustum is the canvas in pixels; zoom fits the garment.
    const cam = camera as THREE.OrthographicCamera;
    const px = gl.domElement.clientWidth || 900;
    cam.zoom = px / (Math.max(size.x, size.y) * 1.12);
    cam.position.set(c.x, c.y, c.z + 5);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    const t = setTimeout(() => {
      (window as unknown as { __shotReady?: boolean }).__shotReady = true;
    }, 800);
    return () => clearTimeout(t);
  }, [geometry, map, camera, gl]);

  if (!geometry || map === undefined) return null;
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        map={map}
        color={map ? '#ffffff' : g.color}
        roughness={0.85}
        side={THREE.DoubleSide}
        alphaTest={g.alpha ? 0.45 : 0}
      />
    </mesh>
  );
}

function Page() {
  const q = useSearchParams();
  const slug = q.get('slug') ?? '';
  const sex = q.get('sex') === 'female' ? 'female' : 'male';
  const [g, setG] = useState<MhGarment | null>(null);
  const [body, setBody] = useState<Float32Array | null>(null);
  useEffect(() => {
    loadMhGarment(slug).then(setG);
    fetch(`/garments/3d/mannequin-${sex}.json`)
      .then((r) => r.json())
      .then((j) => setBody(b64(j.positions)));
  }, [slug, sex]);
  return (
    <div style={{ width: 900, height: 900, background: '#ffffff' }}>
      <Canvas
        orthographic
        camera={{ zoom: 1, near: 0.1, far: 20 }}
        gl={{ preserveDrawingBuffer: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        dpr={1}
      >
        <color attach="background" args={['#ffffff']} />
        <hemisphereLight args={['#ffffff', '#d9d4cc', 1.0]} />
        <directionalLight position={[1.5, 2.5, 4]} intensity={1.6} />
        <directionalLight position={[-2, 1, 3]} intensity={0.6} />
        {g && body && <Shot g={g} body={body} />}
      </Canvas>
    </div>
  );
}

export default function GarmentShotPage() {
  return (
    <Suspense>
      <Page />
    </Suspense>
  );
}
