import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { colors, spacing, typography } from '../../theme/tokens';

export type RenderMode = 'texture' | 'solid' | 'wireframe';
export type LightPreset = 'studio' | 'soft' | 'dramatic';

/**
 * Avatar viewer built on expo-gl + three.js.
 *
 * Runs inside Expo Go, which cannot load native modules — so this is the
 * viewer used for device testing without a custom build. `AvatarViewer.tsx`
 * (Filament) remains the production path: it renders on Metal/Vulkan off the
 * JS thread and handles embedded GLB textures natively.
 *
 * Known limitation: three.js decodes GLB textures through browser APIs
 * (`createImageBitmap`, `document`) that React Native does not provide, so
 * embedded textures will not appear here. Geometry, proportions and scale —
 * the things the pipeline actually computes — render correctly. The viewer
 * says so on screen rather than silently showing a grey body.
 */

interface RigLight {
  intensity: number;
  position: [number, number, number];
}

const RIGS: Record<LightPreset, { key: RigLight; fill: RigLight | null; ambient: number }> = {
  studio: {
    key: { intensity: 2.4, position: [2, 4, 4] },
    fill: { intensity: 0.9, position: [-3, 1, -2] },
    ambient: 0.55,
  },
  soft: {
    key: { intensity: 1.5, position: [0.5, 2.5, 5] },
    fill: { intensity: 0.8, position: [-1, 1, 3] },
    ambient: 0.85,
  },
  dramatic: {
    key: { intensity: 4.0, position: [4, 3, 1.5] },
    fill: null,
    ambient: 0.18,
  },
};

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  model: THREE.Group | null;
  gl: ExpoWebGLRenderingContext;
  lights: THREE.Light[];
}

export function ThreeViewer({
  glbUrl,
  mode,
  light,
  resetToken,
  onStats,
}: {
  glbUrl: string;
  mode: RenderMode;
  light: LightPreset;
  resetToken: number;
  onStats?: (s: { triangles: number; hasTexture: boolean }) => void;
}): React.JSX.Element {
  const refs = useRef<SceneRefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textureMissing, setTextureMissing] = useState(false);

  // Camera in spherical coordinates around the model's mid-height.
  const orbit = useRef({ theta: 0, phi: Math.PI / 2.35, radius: 3.2, targetY: 0.9 });
  const gestureStart = useRef({ theta: 0, phi: 0, radius: 3.2 });

  const applyCamera = useCallback(() => {
    const r = refs.current;
    if (!r) return;
    const { theta, phi, radius, targetY } = orbit.current;
    r.camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      targetY + radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    );
    r.camera.lookAt(0, targetY, 0);
  }, []);

  // ── Gestures ──

  const onOrbit = useCallback(
    (dx: number, dy: number) => {
      orbit.current.theta = gestureStart.current.theta - dx * 0.008;
      // Clamped so the camera never flips through the poles.
      orbit.current.phi = Math.min(
        Math.PI - 0.15,
        Math.max(0.15, gestureStart.current.phi - dy * 0.006),
      );
      applyCamera();
    },
    [applyCamera],
  );

  const onZoom = useCallback(
    (scale: number) => {
      orbit.current.radius = Math.min(8, Math.max(0.8, gestureStart.current.radius / scale));
      applyCamera();
    },
    [applyCamera],
  );

  const beginGesture = useCallback(() => {
    gestureStart.current = { ...orbit.current };
  }, []);

  // runOnJS(true): these callbacks mutate a React ref and drive the three.js
  // camera, both of which live on the JS thread. Running them as worklets
  // would mean marshalling every frame back across the bridge for no gain.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .onBegin(beginGesture)
    .onUpdate((e) => onOrbit(e.translationX, e.translationY));

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(beginGesture)
    .onUpdate((e) => onZoom(e.scale));

  const gesture = Gesture.Simultaneous(pan, pinch);

  // ── Reset ──

  useEffect(() => {
    orbit.current = { theta: 0, phi: Math.PI / 2.35, radius: 3.2, targetY: orbit.current.targetY };
    applyCamera();
  }, [resetToken, applyCamera]);

  // ── Render mode ──

  useEffect(() => {
    const r = refs.current;
    if (!r?.model) return;

    r.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!material) return;

      material.wireframe = mode === 'wireframe';
      material.needsUpdate = true;
    });
  }, [mode]);

  // ── Lighting ──

  useEffect(() => {
    const r = refs.current;
    if (!r) return;

    for (const l of r.lights) r.scene.remove(l);
    r.lights = buildLights(light);
    for (const l of r.lights) r.scene.add(l);
  }, [light]);

  // ── Scene setup ──

  const onContextCreate = useCallback(
    async (gl: ExpoWebGLRenderingContext) => {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      // three.js expects a DOM canvas. expo-gl gives a raw context, so this
      // shim supplies only the handful of properties the renderer touches.
      const canvasShim = {
        width,
        height,
        style: {},
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        clientHeight: height,
        clientWidth: width,
        getContext: () => gl,
      } as unknown as HTMLCanvasElement;

      const renderer = new THREE.WebGLRenderer({
        canvas: canvasShim,
        context: gl as unknown as WebGLRenderingContext,
        antialias: true,
      });
      renderer.setSize(width, height);
      renderer.setClearColor(new THREE.Color(colors.bg), 1);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 100);

      const lights = buildLights(light);
      for (const l of lights) scene.add(l);

      // Ground grid, so the model reads as standing on something.
      const grid = new THREE.GridHelper(4, 16, 0x2a2a2e, 0x1c1c1f);
      scene.add(grid);

      refs.current = { renderer, scene, camera, model: null, gl, lights };
      applyCamera();

      try {
        const model = await loadGlb(glbUrl);
        scene.add(model);
        refs.current.model = model;

        const box = new THREE.Box3().setFromObject(model);
        const height3d = box.max.y - box.min.y;

        // Frame the model regardless of stature: a 1.5 m and a 2 m body should
        // both fill the viewport the same way.
        orbit.current.targetY = height3d * 0.52;
        orbit.current.radius = height3d * 1.85;
        applyCamera();

        let triangles = 0;
        let hasTexture = false;
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const geom = mesh.geometry as THREE.BufferGeometry;
          const positions = geom.attributes.position;
          triangles += geom.index
            ? geom.index.count / 3
            : (positions?.count ?? 0) / 3;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat?.map) hasTexture = true;
        });

        setTextureMissing(!hasTexture);
        onStats?.({ triangles: Math.round(triangles), hasTexture });
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the model');
        setLoading(false);
      }

      const animate = (): void => {
        const r = refs.current;
        if (!r) return;
        requestAnimationFrame(animate);
        r.renderer.render(r.scene, r.camera);
        // expo-gl requires an explicit frame flush.
        r.gl.endFrameEXP();
      };
      animate();
    },
    [glbUrl, light, applyCamera, onStats],
  );

  return (
    <View style={styles.root}>
      <GestureDetector gesture={gesture}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
      </GestureDetector>

      {loading ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.overlayText}>Loading your model…</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayText}>{error}</Text>
        </View>
      ) : null}

      {/* Say what is missing rather than presenting an untextured body as
          finished work. */}
      {!loading && !error && textureMissing && mode === 'texture' ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>
            Shape only — textures need the full app build
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function buildLights(preset: LightPreset): THREE.Light[] {
  const rig = RIGS[preset];
  const lights: THREE.Light[] = [new THREE.AmbientLight(0xffffff, rig.ambient)];

  const key = new THREE.DirectionalLight(0xffffff, rig.key.intensity);
  key.position.set(...rig.key.position);
  lights.push(key);

  if (rig.fill) {
    const fill = new THREE.DirectionalLight(0xdfe6f5, rig.fill.intensity);
    fill.position.set(...rig.fill.position);
    lights.push(fill);
  }

  return lights;
}

async function loadGlb(url: string): Promise<THREE.Group> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = await res.arrayBuffer();

  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(
      buffer,
      '',
      (result) => resolve(result as { scene: THREE.Group }),
      (err) => reject(new Error(String(err))),
    );
  });

  // Guarantee every mesh has a material three.js can render here. GLB textures
  // decoded through browser-only APIs come back null in React Native, which
  // would otherwise render as invisible geometry.
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    const existing = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!existing || !existing.isMaterial) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: 0xb9bec9,
        roughness: 0.82,
        metalness: 0.0,
      });
      return;
    }
    if (!existing.map) {
      existing.color = new THREE.Color(0xb9bec9);
      existing.roughness = 0.82;
      existing.metalness = 0.0;
      existing.needsUpdate = true;
    }
  });

  return gltf.scene;
}

// RN 0.86 dropped `StyleSheet.absoluteFillObject` from the public types.
const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  overlay: {
    ...FILL,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  overlayText: { ...typography.caption, color: colors.textSecondary },
  notice: {
    position: 'absolute',
    top: spacing.md,
    alignSelf: 'center',
    backgroundColor: colors.surfaceOverlay,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  noticeText: { ...typography.caption, color: colors.textSecondary },
});
