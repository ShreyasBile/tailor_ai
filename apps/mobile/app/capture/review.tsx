import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Body, Button, Caption, Screen, Title } from '../../src/components/ui';
import { useCaptureStore } from '../../src/store/capture';
import { useSession } from '../../src/store/session';
import { request, ApiError } from '../../src/lib/api';
import { uploadFile } from '../../src/lib/upload';
import { colors, radius, spacing } from '../../src/theme/tokens';

export default function CaptureReview(): React.JSX.Element {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const isVideo = mode === 'VIDEO_360';

  const {
    photos,
    videoUri,
    videoMirrored,
    reset,
    setSessionId,
    setUploadProgress,
    uploadProgress,
  } = useCaptureStore();
  const { user } = useSession();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'starting'>('idle');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPhase('uploading');

    try {
      const session = await request<{ id: string }>('/capture-sessions', {
        method: 'POST',
        body: {
          mode: isVideo ? 'VIDEO_360' : 'PHOTO_SET',
          qualityHints: { rejectedFrames: 0 },
        },
      });
      setSessionId(session.id);

      if (isVideo && videoUri) {
        await uploadFile({
          sessionId: session.id,
          fileUri: videoUri,
          fileName: 'capture.mp4',
          mimeType: 'video/mp4',
          kind: 'RAW_VIDEO',
          // Photos arrive already un-mirrored from the capture screen; video
          // cannot be flipped on-device, so the server does it.
          mirrored: videoMirrored,
          onProgress: setUploadProgress,
        });
      } else {
        for (let i = 0; i < photos.length; i++) {
          const uri = photos[i]!;
          await uploadFile({
            sessionId: session.id,
            fileUri: uri,
            fileName: `photo_${i}.jpg`,
            mimeType: 'image/jpeg',
            kind: 'RAW_PHOTO',
            onProgress: (f) => setUploadProgress((i + f) / photos.length),
          });
        }
      }

      await request(`/capture-sessions/${session.id}/finalise`, { method: 'POST' });

      setPhase('starting');
      const job = await request<{ id: string }>('/jobs', {
        method: 'POST',
        body: { sessionId: session.id, options: { quality: 'standard', textured: true } },
        // Protects against a double-tap or a network retry creating two jobs.
        idempotencyKey: `${session.id}:reconstruct`,
      });

      reset();
      router.replace(`/processing/${job.id}`);
    } catch (err) {
      setPhase('idle');
      setError(
        err instanceof ApiError ? err.message : 'Upload failed. Check your connection and retry.',
      );
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = isVideo ? !!videoUri : photos.length > 0;

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Looks good?</Title>
          <View style={{ height: spacing.sm }} />
          <Body dim>
            {isVideo
              ? 'Your recording is ready to upload.'
              : `${photos.length} photo${photos.length === 1 ? '' : 's'} ready to upload.`}
          </Body>

          <View style={{ height: spacing.lg }} />

          {isVideo ? (
            <View style={styles.videoPlaceholder}>
              <Body dim>Video captured</Body>
            </View>
          ) : (
            <View style={styles.grid}>
              {photos.map((uri) => (
                <Image key={uri} source={{ uri }} style={styles.thumb} contentFit="cover" />
              ))}
            </View>
          )}

          <View style={{ height: spacing.lg }} />

          {user?.heightCm == null ? (
            <>
              <Caption>
                Tip: adding your height in Profile makes the model real-world accurate. Without
                it we fall back to an average, which is much less precise.
              </Caption>
              <View style={{ height: spacing.md }} />
            </>
          ) : null}

          {error ? (
            <>
              <Caption>{error}</Caption>
              <View style={{ height: spacing.sm }} />
            </>
          ) : null}

          {phase === 'uploading' ? (
            <>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${uploadProgress * 100}%` }]} />
              </View>
              <View style={{ height: spacing.sm }} />
              <Caption>Uploading… {Math.round(uploadProgress * 100)}%</Caption>
              <View style={{ height: spacing.md }} />
            </>
          ) : null}

          <Button
            label={phase === 'starting' ? 'Starting…' : 'Build my model'}
            onPress={() => void submit()}
            loading={busy}
            disabled={!canSubmit}
          />

          <View style={{ height: spacing.sm }} />
          <Button
            label="Retake"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              reset();
              router.replace(`/capture/session?mode=${mode}`);
            }}
          />
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  thumb: {
    width: '47%',
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  videoPlaceholder: {
    height: 200,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.accent },
});
