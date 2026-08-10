import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { Body, Button, Caption, Card, Screen } from '../../src/components/ui';
import { AvatarViewer, type LightPreset, type RenderMode } from '../../src/features/viewer';
import { request } from '../../src/lib/api';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

interface AvatarRender {
  id: string;
  bodyCoreId: string;
  rendererVersion: string;
  stats: {
    vertexCount: number;
    triangleCount: number;
    textureRes: number | null;
    fileSizeBytes: number;
  };
  isTextured: boolean;
  isDegraded: boolean;
  coverage: {
    front: number;
    back: number;
    left: number;
    right: number;
    inpaintedFraction: number;
  } | null;
  assets: { glb: { url: string } | null; thumbnail: { url: string } | null };
}

const MODES: RenderMode[] = ['texture', 'solid', 'wireframe'];
const LIGHTS: LightPreset[] = ['studio', 'soft', 'dramatic'];

export default function Viewer(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [mode, setMode] = useState<RenderMode>('texture');
  const [light, setLight] = useState<LightPreset>('studio');
  const [resetToken, setResetToken] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [exporting, setExporting] = useState(false);

  const avatar = useQuery({
    queryKey: ['avatar', id],
    queryFn: () => request<AvatarRender>(`/avatars/${id}`),
    enabled: !!id,
  });

  const download = async (format: 'GLB' | 'OBJ_ZIP'): Promise<void> => {
    setExporting(true);
    try {
      const created = await request<{ id: string }>(`/avatars/${id}/exports`, {
        method: 'POST',
        body: { format },
      });
      const record = await request<{ download: { url: string } | null }>(
        `/exports/${created.id}`,
      );
      if (!record.download) return;

      const target = `${FileSystem.cacheDirectory}avatar.${format === 'GLB' ? 'glb' : 'zip'}`;
      const { uri } = await FileSystem.downloadAsync(record.download.url, target);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri);
      }
    } finally {
      setExporting(false);
    }
  };

  if (avatar.isLoading) {
    return (
      <Screen>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  // Bind before the guard: narrowing a property off a query result does not
  // survive the intermediate `const data = avatar.data`.
  const data = avatar.data;
  const glb = data?.assets.glb;

  if (avatar.isError || !data || !glb) {
    return (
      <Screen>
        <SafeAreaView style={styles.centered}>
          <Body dim>We couldn&apos;t load this model.</Body>
          <View style={{ height: spacing.lg }} />
          <Button label="Back" onPress={() => router.replace('/(tabs)')} />
        </SafeAreaView>
      </Screen>
    );
  }

  const glbUrl = glb.url;
  const inpainted = data.coverage?.inpaintedFraction ?? 0;

  return (
    <View style={styles.root}>
      <AvatarViewer
        glbUrl={glbUrl}
        mode={mode}
        light={light}
        resetToken={resetToken}
      />

      <SafeAreaView style={styles.hud} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close viewer"
            onPress={() => router.replace('/(tabs)')}
            style={styles.iconButton}
          >
            <Text style={styles.iconText}>✕</Text>
          </Pressable>

          <View style={{ flex: 1 }} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset camera"
            onPress={() => setResetToken((t) => t + 1)}
            style={styles.iconButton}
          >
            <Text style={styles.iconText}>⟳</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle model statistics"
            onPress={() => setShowStats((s) => !s)}
            style={styles.iconButton}
          >
            <Text style={styles.iconText}>ⓘ</Text>
          </Pressable>
        </View>

        {showStats ? (
          <Card style={styles.stats}>
            <Row label="Vertices" value={data.stats.vertexCount.toLocaleString()} />
            <Row label="Triangles" value={data.stats.triangleCount.toLocaleString()} />
            <Row
              label="Texture"
              value={data.stats.textureRes ? `${data.stats.textureRes}px` : 'none'}
            />
            <Row
              label="File size"
              value={`${(data.stats.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`}
            />
            <Row label="Renderer" value={data.rendererVersion} />
          </Card>
        ) : null}

        <View style={{ flex: 1 }} />

        <ScrollView contentContainerStyle={styles.bottom}>
          {/*
            Coverage honesty: surfaces which parts of the surface were inferred
            rather than observed. Turning a hidden weakness into a visible,
            explained one is what keeps this an instrument rather than a toy.
          */}
          {inpainted > 0.15 ? (
            <>
              <Card style={styles.notice}>
                <Text style={styles.noticeTitle}>Some areas were estimated</Text>
                <Caption>
                  We couldn&apos;t see {Math.round(inpainted * 100)}% of your surface — usually
                  under the arms and inner legs. A slower full turn improves this.
                </Caption>
              </Card>
              <View style={{ height: spacing.sm }} />
            </>
          ) : null}

          {data.isDegraded ? (
            <>
              <Card style={styles.notice}>
                <Text style={styles.noticeTitle}>Untextured model</Text>
                <Caption>
                  We built your shape but couldn&apos;t finish the colour. The geometry is still
                  accurate.
                </Caption>
              </Card>
              <View style={{ height: spacing.sm }} />
            </>
          ) : null}

          <SegmentedControl
            options={MODES}
            value={mode}
            onChange={setMode}
            labels={{ texture: 'Textured', solid: 'Solid', wireframe: 'Wireframe' }}
          />

          <View style={{ height: spacing.sm }} />

          <SegmentedControl
            options={LIGHTS}
            value={light}
            onChange={setLight}
            labels={{ studio: 'Studio', soft: 'Soft', dramatic: 'Dramatic' }}
          />

          <View style={{ height: spacing.md }} />

          <View style={styles.actions}>
            <Button
              label="Download GLB"
              onPress={() => void download('GLB')}
              loading={exporting}
              style={{ flex: 1 }}
            />
            <Button
              label="OBJ"
              variant="secondary"
              onPress={() => void download('OBJ_ZIP')}
              disabled={exporting}
              style={{ width: 92 }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  labels: Record<string, string>;
}): React.JSX.Element {
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={labels[option] ?? option}
            onPress={() => onChange(option)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {labels[option] ?? option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  // RN 0.86 dropped `StyleSheet.absoluteFillObject` from the public types.
  hud: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceOverlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: colors.text, fontSize: 16 },
  stats: { marginHorizontal: spacing.md, backgroundColor: colors.surfaceOverlay },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  rowLabel: { ...typography.caption, color: colors.textSecondary },
  rowValue: { ...typography.caption, color: colors.text, fontWeight: '600' },
  bottom: { padding: spacing.md, paddingBottom: spacing.lg },
  notice: { backgroundColor: colors.surfaceOverlay },
  noticeTitle: { ...typography.callout, color: colors.text, fontWeight: '600', marginBottom: 2 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: '#fff' },
  actions: { flexDirection: 'row', gap: spacing.sm },
});
