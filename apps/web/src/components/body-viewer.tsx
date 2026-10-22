'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface Highlight {
  kind: 'girth' | 'width' | 'length';
  y?: number | null;
  y0?: number | null;
  y1?: number | null;
  side?: string;
  label: string;
  value: string;
}

const CLAY = new THREE.MeshStandardMaterial({ color: '#d9cab8', roughness: 0.78, metalness: 0.0 });
const ACCENT = '#2f5d50';

function useBodyGeometry(url: string) {
  const gltf = useGLTF(url);
  return useMemo(() => {
    const scene = gltf.scene.clone(true);
    const points: THREE.Vector3[] = [];
    const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = CLAY;
      mesh.castShadow = true;
      // The export has unshared vertices per face (flat shading). Weld them so
      // normals average across faces and the clay body reads smooth.
      let geo = mesh.geometry.clone();
      for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
      geo = mergeVertices(geo, 1e-4);
      geo.computeVertexNormals();
      mesh.geometry = geo;
      const pos = mesh.geometry.getAttribute('position');
      const base = points.length;
      for (let i = 0; i < pos.count; i++) {
        points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
      }
      const index = mesh.geometry.getIndex();
      const n = index ? index.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i + 1) : i + 1;
        const c = index ? index.getX(i + 2) : i + 2;
        tris.push([points[base + a], points[base + b], points[base + c]]);
      }
    });
    const box = new THREE.Box3().setFromPoints(points);
    return { scene, tris, box };
  }, [gltf]);
}

/** Where the plane at height y cuts each triangle's edges. */
function planeSection(tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][], y: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const t of tris) {
    const cut: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const p = t[i];
      const q = t[(i + 1) % 3];
      if ((p.y - y) * (q.y - y) < 0) {
        cut.push(new THREE.Vector3().lerpVectors(p, q, (y - p.y) / (q.y - p.y)));
      }
    }
    // Each cut triangle contributes a segment of the outline; sample along it
    // so the section is a dense curve (gaps then only appear between limbs).
    if (cut.length === 2) {
      for (let k = 0; k <= 6; k++) out.push(new THREE.Vector3().lerpVectors(cut[0], cut[1], k / 6));
    }
  }
  return out;
}

/** Cross-section of the body at height y, split into blobs (torso, arms,
 * legs); returns the torso (or one leg / one arm) the ring is drawn round. */
function sliceCluster(tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][], y: number, side: string, cx: number) {
  const pts = planeSection(tris, y).sort((a, b) => a.x - b.x);
  if (pts.length < 6) return null;
  const clusters: THREE.Vector3[][] = [];
  let cur: THREE.Vector3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x - pts[i - 1].x > 0.012) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(pts[i]);
  }
  clusters.push(cur);
  const centre = (c: THREE.Vector3[]) => (c[0].x + c[c.length - 1].x) / 2;
  let pick: THREE.Vector3[] | undefined;
  if (side === 'leg' || side === 'arm') {
    const right = clusters.filter((c) => centre(c) > cx + 0.01);
    pick = side === 'arm' ? right[right.length - 1] : right[0];
  }
  pick ??= clusters.reduce((a, b) => (Math.abs(centre(a) - cx) < Math.abs(centre(b) - cx) ? a : b));
  if (!pick || pick.length < 3) return null;
  const xs = pick.map((p) => p.x);
  const zs = pick.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2, minX, maxX, maxZ };
}

function MeasureOverlay({
  h,
  tris,
  box,
}: {
  h: Highlight;
  tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][];
  box: THREE.Box3;
}) {
  const H = box.max.y - box.min.y;
  const cx = (box.min.x + box.max.x) / 2;

  const shape = useMemo(() => {
    if (h.kind === 'length') {
      const y0 = box.min.y + (h.y0 ?? 0) * H;
      const y1 = box.min.y + (h.y1 ?? 1) * H;
      const x = box.max.x + 0.07;
      return {
        lines: [
          [new THREE.Vector3(x, y0, 0), new THREE.Vector3(x, y1, 0)],
          [new THREE.Vector3(x - 0.025, y0, 0), new THREE.Vector3(x + 0.025, y0, 0)],
          [new THREE.Vector3(x - 0.025, y1, 0), new THREE.Vector3(x + 0.025, y1, 0)],
        ],
        anchor: new THREE.Vector3(x + 0.04, (y0 + y1) / 2, 0),
      };
    }
    const y = box.min.y + (h.y ?? 0.5) * H;
    const s = sliceCluster(tris, y, h.side ?? 'torso', cx);
    if (!s) return null;
    if (h.kind === 'width') {
      const z = s.maxZ + 0.02;
      return {
        lines: [
          [new THREE.Vector3(s.minX, y, z), new THREE.Vector3(s.maxX, y, z)],
          [new THREE.Vector3(s.minX, y - 0.02, z), new THREE.Vector3(s.minX, y + 0.02, z)],
          [new THREE.Vector3(s.maxX, y - 0.02, z), new THREE.Vector3(s.maxX, y + 0.02, z)],
        ],
        anchor: new THREE.Vector3(s.maxX + 0.05, y, z),
      };
    }
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      ring.push(new THREE.Vector3(s.cx + Math.cos(t) * s.rx * 1.06 + 0.002, y, s.cz + Math.sin(t) * s.rz * 1.08));
    }
    return { lines: [ring], anchor: new THREE.Vector3(s.cx + s.rx * 1.06 + 0.05, y, s.cz) };
  }, [h, tris, box, H, cx]);

  if (!shape) return null;
  return (
    <group>
      {shape.lines.map((pts, i) => (
        <Line key={i} points={pts} color={ACCENT} lineWidth={i === 0 ? 3 : 2} depthTest={false} renderOrder={10} />
      ))}
      <Html position={shape.anchor} center={false} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="-translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-white/95 px-2.5 py-1 text-xs shadow-lift">
          <span className="text-ink-muted">{h.label}</span> <span className="font-semibold text-ink">{h.value}</span>
        </div>
      </Html>
    </group>
  );
}

function Body({ url, highlight, spin }: { url: string; highlight: Highlight | null; spin: boolean }) {
  const { scene, tris, box } = useBodyGeometry(url);
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (spin && group.current && !highlight) group.current.rotation.y += dt * 0.35;
  });
  useEffect(() => {
    // Face the camera when a measurement is selected, so the overlay reads.
    if (highlight && group.current) group.current.rotation.y = 0;
  }, [highlight]);

  return (
    <group ref={group}>
      <primitive object={scene} />
      {highlight && <MeasureOverlay h={highlight} tris={tris} box={box} />}
    </group>
  );
}

export function BodyViewer({
  url,
  heightM,
  highlight,
}: {
  url: string;
  heightM: number;
  highlight: Highlight | null;
}) {
  const [spin, setSpin] = useState(true);
  const controls = useRef<OrbitControlsImpl>(null);
  const target: [number, number, number] = [0, heightM * 0.52, 0];

  return (
    <div className="relative h-full w-full">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0.35, heightM * 0.62, heightM * 2.05], fov: 34, near: 0.05, far: 50 }}
      >
        <color attach="background" args={['#f1eee7']} />
        <hemisphereLight args={['#ffffff', '#cfc6b8', 0.9]} />
        <directionalLight position={[2.5, 4, 3]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-3, 2.5, -2]} intensity={0.55} color="#dfe8ff" />
        <Suspense fallback={<Html center><span className="text-xs text-ink-muted">Loading body…</span></Html>}>
          <Body url={url} highlight={highlight} spin={spin} />
        </Suspense>
        <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={3} blur={2.4} far={2} />
        <OrbitControls
          ref={controls}
          target={target}
          enablePan={false}
          minDistance={1.2}
          maxDistance={6}
          minPolarAngle={0.3}
          maxPolarAngle={Math.PI / 1.9}
          onStart={() => setSpin(false)}
        />
      </Canvas>
      <div className="absolute bottom-3 right-3 flex gap-1.5">
        <ViewerBtn label={spin ? 'Pause rotation' : 'Rotate'} onClick={() => setSpin((s) => !s)}>
          {spin ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </ViewerBtn>
        <ViewerBtn label="Reset view" onClick={() => controls.current?.reset()}>
          <RotateCcw className="h-4 w-4" />
        </ViewerBtn>
      </div>
      <p className="pointer-events-none absolute bottom-4 left-4 text-[11px] text-ink-muted">Drag to rotate · scroll to zoom</p>
    </div>
  );
}

function ViewerBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-line bg-white/90 text-ink-soft shadow-soft backdrop-blur transition hover:text-ink"
    >
      {children}
    </button>
  );
}
