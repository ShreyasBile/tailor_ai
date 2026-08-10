import React from 'react';
import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Caption, Card, ConfidenceBadge, Screen, Title } from '../../src/components/ui';
import { request, ApiError } from '../../src/lib/api';
import { useSession } from '../../src/store/session';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

interface AvatarRender {
  id: string;
  bodyCoreId: string;
  stats: { vertexCount: number; triangleCount: number; fileSizeBytes: number };
  isTextured: boolean;
  isDegraded: boolean;
  coverage: { inpaintedFraction: number } | null;
  createdAt: string;
  assets: { glb: { url: string } | null; thumbnail: { url: string } | null };
}

interface BodyCore {
  id: string;
  version: number;
  scale: { source: string; heightCm: number | null; confidence: number | null };
  quality: { overall: number | null; frameCount: number; captureMode: string };
  createdAt: string;
}

export default function Home(): React.JSX.Element {
  const router = useRouter();
  const { user } = useSession();

  const avatar = useQuery({
    queryKey: ['avatar', 'latest'],
    queryFn: () => request<AvatarRender>('/me/avatar'),
    // 404 means "no avatar yet", which is a normal state, not a failure.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  const core = useQuery({
    queryKey: ['bodyCore', 'current'],
    queryFn: () => request<BodyCore>('/me/body-core'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  const hasAvatar = !!avatar.data;
  const needsHeight = user?.heightCm == null;

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>{greeting()}</Title>
          <View style={{ height: spacing.lg }} />

          {avatar.isLoading ? (
            <Card style={styles.placeholder}>
              <ActivityIndicator color={colors.accent} />
            </Card>
          ) : hasAvatar ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open your 3D avatar"
              onPress={() => router.push(`/viewer/${avatar.data!.id}`)}
            >
              <Card style={styles.avatarCard}>
                {avatar.data!.assets.thumbnail ? (
                  <Image
                    source={{ uri: avatar.data!.assets.thumbnail.url }}
                    style={styles.thumb}
                    contentFit="contain"
                    transition={220}
                  />
                ) : (
                  <View style={styles.thumb} />
                )}

                <View style={styles.avatarMeta}>
                  <Text style={styles.metaTitle}>Your body model</Text>
                  <Caption>
                    {core.data?.scale.heightCm
                      ? `${Math.round(core.data.scale.heightCm)} cm · `
                      : ''}
                    {avatar.data!.stats.triangleCount.toLocaleString()} triangles
                  </Caption>

                  <View style={{ height: spacing.sm }} />

                  {core.data?.quality.overall != null ? (
                    <ConfidenceBadge value={core.data.quality.overall} />
                  ) : null}

                  {avatar.data!.isDegraded ? (
                    <>
                      <View style={{ height: spacing.xs }} />
                      <Caption>Texture unavailable — showing untextured model</Caption>
                    </>
                  ) : null}
                </View>
              </Card>
            </Pressable>
          ) : (
            <Card style={styles.placeholder}>
              <Text style={styles.placeholderGlyph}>◍</Text>
              <View style={{ height: spacing.sm }} />
              <Body dim>You haven&apos;t created a body model yet.</Body>
            </Card>
          )}

          <View style={{ height: spacing.lg }} />

          {needsHeight ? (
            <>
              <Card>
                <Text style={styles.cardHeading}>Add your height first</Text>
                <Body dim>
                  A photo alone can&apos;t tell how tall you are — a tall person far away looks
                  identical to a short person nearby. Your height is what makes the model
                  real-world accurate.
                </Body>
                <View style={{ height: spacing.md }} />
                <Button
                  label="Add height"
                  variant="secondary"
                  onPress={() => router.push('/(tabs)/profile')}
                />
              </Card>
              <View style={{ height: spacing.md }} />
            </>
          ) : null}

          <Button
            label={hasAvatar ? 'New scan' : 'Create your body model'}
            onPress={() => router.push('/capture/intro')}
          />

          <View style={{ height: spacing.md }} />
          <Caption>
            Scans take about two to three minutes. Your photos are deleted after 30 days.
          </Caption>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  avatarCard: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  thumb: {
    width: 96,
    height: 128,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  avatarMeta: { flex: 1 },
  metaTitle: { ...typography.heading, color: colors.text, marginBottom: 2 },
  placeholder: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl },
  placeholderGlyph: { fontSize: 44, color: colors.textTertiary },
  cardHeading: { ...typography.heading, color: colors.text, marginBottom: spacing.xs },
});
