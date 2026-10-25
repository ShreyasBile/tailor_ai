'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Kind } from '@/components/garment-art';
import type { FitDimension } from '@/lib/types';
import { buildTryOn, type Landmarks, type ZoneTag } from '@/lib/tryon';

const CLAY = new THREE.MeshStandardMaterial({ color: '#d9cab8', roughness: 0.78, metalness: 0.0 });

export type TryOnMode = 'fit' | 'fabric';

export interface TryOnProps {
  url: string;
  heightM: number;
  kind: Kind;
  category: string;
  fitIntent: string;
  colorHex: string;
  dims: FitDimension[];
  landmarks: Landmarks;
  armLengthCm?: number;
  inseamCm?: number;
  mode: TryOnMode;
  units: 'cm' | 'in';
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

/** "Waist 13 cm too small", "Sleeve 11 cm too long", "Chest fits". */
function tagText(t: ZoneTag, units: 'cm' | 'in') {
  const v = Math.abs(units === 'in' ? t.deltaCm / 2.54 : t.deltaCm);
  if (t.unsure) return `${t.label}: unsure`;
  if (Math.abs(t.deltaCm) < 1) return `${t.label} fits`;
  const amount = `${v.toFixed(units === 'in' ? 1 : 0)} ${units}`;
  const word = t.isLength ? (t.deltaCm > 0 ? 'too short' : 'too long') : t.deltaCm > 0 ? 'too small' : 'too big';
  return `${t.label} ${amount} ${word}`;
}

function Scene(props: TryOnProps & { spin: boolean }) {
  const body = useBody(props.url);
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (props.spin && group.current) group.current.rotation.y += dt * 0.3;
  });

  const result = useMemo(
    () =>
      buildTryOn({
        geometry: body,
        kind: props.kind,
        category: props.category,
        fitIntent: props.fitIntent,
        dims: props.dims,
        landmarks: props.landmarks,
        armLengthCm: props.armLengthCm,
        inseamCm: props.inseamCm,
      }),
    [body, props.kind, props.category, props.fitIntent, props.dims, props.landmarks, props.armLengthCm, props.inseamCm],
  );

  const material = useMemo(() => {
    if (props.mode === 'fit') {
      return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    }
    return new THREE.MeshStandardMaterial({ color: props.colorHex, roughness: 0.9, side: THREE.DoubleSide });
  }, [props.mode, props.colorHex]);

  return (
    <group ref={group}>
      <mesh geometry={body} material={CLAY} castShadow />
      <mesh geometry={result.garment} material={material} castShadow />
      {props.mode === 'fit' &&
        result.tags.map((t) => (
          <Html key={t.name} position={t.position} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div
              className="-translate-y-1/2 whitespace-nowrap rounded-full border bg-white/95 px-2 py-0.5 text-[11px] font-medium shadow-soft"
              style={{ borderColor: t.color, color: t.color }}
            >
              {tagText(t, props.units)}
            </div>
          </Html>
        ))}
    </group>
  );
}

export function TryOnViewer(props: TryOnProps) {
  const [spin, setSpin] = useState(false);
  const controls = useRef<OrbitControlsImpl>(null);
  const { heightM } = props;

  return (
    <div className="relative h-full w-full">
      <Canvas shadows dpr={[1, 2]} camera={{ position: [0.3, heightM * 0.6, heightM * 2.0], fov: 34, near: 0.05, far: 50 }}>
        <color attach="background" args={['#f1eee7']} />
        <hemisphereLight args={['#ffffff', '#cfc6b8', 0.9]} />
        <directionalLight position={[2.5, 4, 3]} intensity={1.5} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-3, 2.5, -2]} intensity={0.55} color="#dfe8ff" />
        <Suspense fallback={<Html center><span className="text-xs text-ink-muted">Loading your body…</span></Html>}>
          <Scene {...props} spin={spin} />
        </Suspense>
        <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={3} blur={2.4} far={2} />
        <OrbitControls
          ref={controls}
          target={[0, heightM * 0.52, 0]}
          enablePan={false}
          minDistance={1.0}
          maxDistance={6}
          minPolarAngle={0.3}
          maxPolarAngle={Math.PI / 1.9}
          onStart={() => setSpin(false)}
        />
      </Canvas>
      <div className="absolute bottom-3 right-3 flex gap-1.5">
        <button
          type="button"
          title={spin ? 'Pause rotation' : 'Rotate'}
          aria-label={spin ? 'Pause rotation' : 'Rotate'}
          onClick={() => setSpin((v) => !v)}
          className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-line bg-white/90 text-ink-soft shadow-soft"
        >
          {spin ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          type="button"
          title="Reset view"
          aria-label="Reset view"
          onClick={() => controls.current?.reset()}
          className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-line bg-white/90 text-ink-soft shadow-soft"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
