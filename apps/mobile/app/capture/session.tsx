import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
} from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { manipulateAsync, FlipType, SaveFormat } from 'expo-image-manipulator';
import { Body, Button, Caption, Screen, Title } from '../../src/components/ui';
import { SilhouetteOverlay } from '../../src/features/capture/SilhouetteOverlay';
import { useTiltCheck } from '../../src/features/capture/useTiltCheck';
import { useCaptureStore } from '../../src/store/capture';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

const VIDEO_SECONDS = 25;
const PHOTO_ANGLES = ['Front', 'Right side', 'Back', 'Left side'] as const;
const AUTO_CAPTURE_DELAY_MS = 3000;

export default function CaptureSession(): React.JSX.Element {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const isVideo = mode === 'VIDEO_360';

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [angleIndex, setAngleIndex] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Back by default: it has the better sensor, and a propped-up phone doing a
  // 360° turn is the capture we actually want. Front exists because you cannot
  // see the silhouette guide while the back camera faces you.
  const [facing, setFacing] = useState<CameraType>('back');

  const tilt = useTiltCheck(true);
  const { reset, addPhoto, setVideo, photos } = useCaptureStore();

  useEffect(() => {
    reset();
  }, [reset]);

  // ── Video recording ──

  useEffect(() => {
    if (!recording) return;

    const timer = setInterval(() => {
      setElapsed((e) => {
        const next = e + 0.1;
        if (next >= VIDEO_SECONDS) {
          void stopRecording();
          return VIDEO_SECONDS;
        }
        // Haptic at each quarter turn, so the user can pace their rotation
        // without looking at the screen — which they cannot do while turning.
        const quarter = VIDEO_SECONDS / 4;
        if (Math.floor(next / quarter) !== Math.floor(e / quarter)) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        return next;
      });
    }, 100);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const startRecording = async (): Promise<void> => {
    if (!cameraRef.current) return;
    setElapsed(0);
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: VIDEO_SECONDS + 2 });
      if (video?.uri) {
        // Front-camera video is mirrored and cannot be flipped on-device
        // without re-encoding; the server un-mirrors it during extraction.
        setVideo(video.uri, facing === 'front');
        router.replace('/capture/review?mode=VIDEO_360');
      }
    } catch {
      setRecording(false);
    }
  };

  const stopRecording = async (): Promise<void> => {
    setRecording(false);
    cameraRef.current?.stopRecording();
  };

  // ── Photo capture ──

  const capturePhoto = useCallback(async (): Promise<void> => {
    if (!cameraRef.current) return;
    try {
      const photo: CameraCapturedPicture | undefined = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: false,
      });
      if (!photo?.uri) return;

      // Undo the preview mirroring so the stored image matches reality. Done
      // here rather than server-side because it is cheap for a still, and it
      // means nothing downstream has to know which lens took the shot.
      const uri = facing === 'front' ? await unmirror(photo.uri) : photo.uri;

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      addPhoto(uri);

      const next = angleIndex + 1;
      if (next >= PHOTO_ANGLES.length) {
        router.replace('/capture/review?mode=PHOTO_SET');
      } else {
        setAngleIndex(next);
        setCountdown(null);
      }
    } catch {
      setCountdown(null);
    }
  }, [angleIndex, addPhoto, router, facing]);

  // Auto-capture countdown: the user needs both hands free to hold the pose,
  // so tapping a shutter button for each angle is not workable.
  useEffect(() => {
    if (isVideo || countdown === null) return;

    if (countdown <= 0) {
      void capturePhoto();
      return;
    }

    const timer = setTimeout(() => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCountdown((c) => (c === null ? null : c - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, isVideo, capturePhoto]);

  // ── Permission states ──

  if (!permission) {
    return (
      <Screen>
        <SafeAreaView style={styles.centered} />
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen>
        <SafeAreaView style={[styles.centered, { padding: spacing.lg }]}>
          <Title>Camera access</Title>
          <View style={{ height: spacing.sm }} />
          <Body dim>
            TailorAI needs your camera to capture the photos used to build your body model.
          </Body>
          <View style={{ height: spacing.lg }} />
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        </SafeAreaView>
      </Screen>
    );
  }

  const guideState: 'ok' | 'adjust' | 'bad' = !tilt.isUpright ? 'adjust' : 'ok';
  const progress = isVideo ? elapsed / VIDEO_SECONDS : angleIndex / PHOTO_ANGLES.length;

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode={isVideo ? 'video' : 'picture'}
        // Mirrored preview on the front camera, because framing yourself
        // against a non-mirrored image is genuinely disorienting.
        //
        // expo-camera ties preview and output to this one flag, so the frames
        // it produces are mirrored too — and a mirrored body would put your
        // left shoulder's measurements on your right side. That is corrected
        // before the data reaches the pipeline: photos are flipped back here
        // on-device (see capturePhoto), video carries a `mirrored` flag the
        // server honours during frame extraction.
        mirror={facing === 'front'}
      />

      <SilhouetteOverlay state={guideState} />

      <SafeAreaView style={styles.hud} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel capture"
            onPress={() => router.back()}
            style={styles.close}
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          </View>

          {/* Switching lenses mid-recording restarts the capture session on
              iOS and would corrupt the clip, so it is disabled while rolling. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              facing === 'back' ? 'Switch to front camera' : 'Switch to back camera'
            }
            accessibilityState={{ disabled: recording }}
            disabled={recording}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setFacing((f) => (f === 'back' ? 'front' : 'back'));
            }}
            style={[styles.close, recording && styles.disabledControl]}
          >
            <Text style={styles.closeText}>⟳</Text>
          </Pressable>
        </View>

        {facing === 'front' ? (
          <View style={styles.lensNote} pointerEvents="none">
            <Text style={styles.lensNoteText}>
              Front camera — easier to frame, lower detail
            </Text>
          </View>
        ) : null}

        <View style={styles.bottom}>
          {/* Guidance is announced as text and read aloud by screen readers —
              a user positioning themselves usually cannot see the screen. */}
          <View
            accessibilityLiveRegion="polite"
            accessibilityLabel={instruction(isVideo, tilt.isUpright, angleIndex, recording)}
            style={styles.instructionBox}
          >
            <Text style={styles.instruction}>
              {instruction(isVideo, tilt.isUpright, angleIndex, recording)}
            </Text>
            {!tilt.isUpright && tilt.available ? (
              <Caption>Hold your phone upright ({Math.round(tilt.tiltDeg)}° off)</Caption>
            ) : null}
          </View>

          <View style={{ height: spacing.md }} />

          {isVideo ? (
            recording ? (
              <View style={styles.recordingRow}>
                <Text style={styles.timer}>
                  {Math.max(0, VIDEO_SECONDS - elapsed).toFixed(0)}s
                </Text>
                <Button label="Stop" variant="danger" onPress={() => void stopRecording()} />
              </View>
            ) : (
              <Button label="Start recording" onPress={() => void startRecording()} />
            )
          ) : countdown !== null ? (
            <View style={styles.countdownBox}>
              <Text style={styles.countdown}>{countdown === 0 ? '📸' : countdown}</Text>
            </View>
          ) : (
            <Button
              label={`Capture ${PHOTO_ANGLES[angleIndex]?.toLowerCase() ?? ''}`}
              onPress={() => setCountdown(Math.round(AUTO_CAPTURE_DELAY_MS / 1000))}
            />
          )}

          {!isVideo ? (
            <>
              <View style={{ height: spacing.sm }} />
              <Caption>
                {photos.length} of {PHOTO_ANGLES.length} captured
              </Caption>
            </>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * Horizontally flips an image, undoing the front camera's preview mirroring.
 *
 * If this fails the original is returned rather than losing the shot: a
 * laterally-flipped body is a bad reconstruction, but no reconstruction at all
 * is worse. The failure is logged so it is not silent.
 */
async function unmirror(uri: string): Promise<string> {
  try {
    const result = await manipulateAsync(uri, [{ flip: FlipType.Horizontal }], {
      format: SaveFormat.JPEG,
      compress: 0.92,
    });
    return result.uri;
  } catch (err) {
    console.warn('[capture] could not un-mirror front-camera photo', err);
    return uri;
  }
}

function instruction(
  isVideo: boolean,
  upright: boolean,
  angleIndex: number,
  recording: boolean,
): string {
  if (!upright) return 'Straighten your phone';
  if (isVideo) {
    return recording ? 'Turn slowly, all the way around' : 'Step back until you fill the outline';
  }
  return `Face ${PHOTO_ANGLES[angleIndex]?.toLowerCase() ?? 'forward'}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'flex-start' },
  hud: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: '#fff', fontSize: 18 },
  disabledControl: { opacity: 0.35 },
  lensNote: {
    alignSelf: 'center',
    marginTop: spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  lensNoteText: { ...typography.caption, color: '#D8D8DE' },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.accent },
  bottom: { padding: spacing.lg },
  instructionBox: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  instruction: { ...typography.heading, color: '#fff', textAlign: 'center' },
  recordingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  timer: { ...typography.title, color: '#fff', minWidth: 64 },
  countdownBox: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.md,
  },
  countdown: { ...typography.display, color: '#fff' },
});
