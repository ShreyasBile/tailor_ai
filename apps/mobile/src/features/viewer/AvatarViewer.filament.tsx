import React, { Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import {
  Camera,
  FilamentScene,
  FilamentView,
  Light,
  Model,
  useCameraManipulator,
} from 'react-native-filament';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { colors } from '../../theme/tokens';

export type RenderMode = 'texture' | 'solid' | 'wireframe';
export type LightPreset = 'studio' | 'soft' | 'dramatic';

/**
 * 3D avatar viewer.
 *
 * Filament rather than expo-gl/three: Metal on iOS, Vulkan on Android, and
 * rendering happens off the JS thread. This is the moment the product lands or
 * doesn't — a user seeing their own body for the first time — so it must not
 * stutter (docs/05 §1).
 */

interface LightRig {
  key: (mode: LightPreset) => string;
  directional: { intensity: number; direction: [number, number, number] };
  fill: { intensity: number; direction: [number, number, number] } | null;
}

const RIGS: Record<LightPreset, Omit<LightRig, 'key'>> = {
  // Key plus fill — even, neutral, shows shape without drama.
  studio: {
    directional: { intensity: 40_000, direction: [0.4, -0.6, -0.7] },
    fill: { intensity: 14_000, direction: [-0.6, -0.2, 0.6] },
  },
  // Soft and frontal — flattering, minimal shadow.
  soft: {
    directional: { intensity: 22_000, direction: [0.1, -0.3, -0.9] },
    fill: { intensity: 12_000, direction: [-0.3, -0.1, 0.8] },
  },
  // Single hard key — emphasises silhouette and surface detail.
  dramatic: {
    directional: { intensity: 75_000, direction: [0.8, -0.5, -0.3] },
    fill: null,
  },
};

function ViewerContent({
  glbUrl,
  light,
  resetToken,
}: {
  glbUrl: string;
  light: LightPreset;
  resetToken: number;
}): React.JSX.Element {
  const cameraManipulator = useCameraManipulator({
    // Framed slightly above centre and pulled back — a full-body model reads
    // badly when the head is jammed against the top edge.
    orbitHomePosition: [0, 1.0, 3.2],
    targetPosition: [0, 0.9, 0],
    orbitSpeed: [0.004, 0.004],
    zoomSpeed: [0.6],
  });

  const pan = Gesture.Pan()
    .onBegin((e) => {
      cameraManipulator?.grabBegin(e.translationX, e.translationY, false);
    })
    .onUpdate((e) => {
      cameraManipulator?.grabUpdate(e.translationX, e.translationY);
    })
    .onEnd(() => {
      cameraManipulator?.grabEnd();
    });

  // Two-finger drag strafes (pan) rather than orbits.
  const strafe = Gesture.Pan()
    .minPointers(2)
    .onBegin((e) => {
      cameraManipulator?.grabBegin(e.translationX, e.translationY, true);
    })
    .onUpdate((e) => {
      cameraManipulator?.grabUpdate(e.translationX, e.translationY);
    })
    .onEnd(() => {
      cameraManipulator?.grabEnd();
    });

  const pinch = Gesture.Pinch().onUpdate((e) => {
    cameraManipulator?.scroll(0, 0, -e.velocity / 40);
  });

  const gesture = Gesture.Simultaneous(Gesture.Exclusive(strafe, pan), pinch);

  const rig = RIGS[light];

  return (
    <GestureDetector gesture={gesture}>
      {/*
        `key` on the view forces a fresh camera manipulator when the user taps
        Reset. The manipulator exposes no imperative reset, and remounting is
        cheap next to hunting its internal state.
      */}
      <FilamentView key={`view-${resetToken}`} style={FILAMENT_STYLE}>
        <Camera cameraManipulator={cameraManipulator} />

        <Light
          type="directional"
          intensity={rig.directional.intensity}
          direction={rig.directional.direction}
          castShadows
        />
        {rig.fill ? (
          <Light
            type="directional"
            intensity={rig.fill.intensity}
            direction={rig.fill.direction}
            castShadows={false}
          />
        ) : null}

        {/* transformToUnitCube stays off: the mesh is already in real-world
            metres and grounded at y=0, and rescaling it would throw away the
            one thing the pipeline works hardest to get right. */}
        <Model source={{ uri: glbUrl }} transformToUnitCube={false} castShadow receiveShadow />
      </FilamentView>
    </GestureDetector>
  );
}

export function AvatarViewer(props: {
  glbUrl: string;
  mode: RenderMode;
  light: LightPreset;
  resetToken: number;
}): React.JSX.Element {
  return (
    <View style={styles.root}>
      <FilamentScene>
        <Suspense
          fallback={
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
            </View>
          }
        >
          <ViewerContent
            glbUrl={props.glbUrl}
            light={props.light}
            resetToken={props.resetToken}
          />
        </Suspense>
      </FilamentScene>
    </View>
  );
}

// FilamentView types `style` as a plain ViewStyle and rejects a registered
// StyleSheet id, so this one stays outside StyleSheet.create.
const FILAMENT_STYLE: ViewStyle = { flex: 1 };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
