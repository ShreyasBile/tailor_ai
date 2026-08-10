import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Body, Button, Caption, Card, ConfidenceBadge, Screen, Title } from '../../src/components/ui';
import { useSession } from '../../src/store/session';
import { request, ApiError } from '../../src/lib/api';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';

interface BodyCore {
  id: string;
  version: number;
  isCurrent: boolean;
  scale: { source: string; heightCm: number | null; confidence: number | null };
  quality: { overall: number | null; frameCount: number; captureMode: string };
  createdAt: string;
}

const SCALE_EXPLANATION: Record<string, string> = {
  USER_HEIGHT: 'Sized from the height you gave us',
  ARKIT_DEPTH: 'Sized using your phone’s depth sensor',
  REFERENCE_OBJECT: 'Sized from a reference object in frame',
  STATISTICAL_PRIOR: 'Estimated from population averages — add your height for accuracy',
};

export default function Profile(): React.JSX.Element {
  const router = useRouter();
  const { user, updateProfile, signOut } = useSession();

  const [height, setHeight] = useState(user?.heightCm ? String(Math.round(user.heightCm)) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['bodyCore', 'history'],
    queryFn: () => request<BodyCore[]>('/me/body-core/history'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  const saveHeight = async (): Promise<void> => {
    const value = Number(height);
    if (!Number.isFinite(value) || value < 50 || value > 260) {
      setError('Please enter a height between 50 and 260 cm.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ heightCm: value });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (): void => {
    Alert.alert(
      'Delete everything?',
      'This permanently removes your body model, all scans, and your account. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await request('/me', { method: 'DELETE' });
            await signOut();
            router.replace('/(auth)/sign-in');
          },
        },
      ],
    );
  };

  const current = history.data?.find((c: BodyCore) => c.isCurrent);

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Profile</Title>
          <View style={{ height: spacing.lg }} />

          {/* Height first: it is the single largest accuracy lever available. */}
          <Card>
            <Text style={styles.heading}>Your height</Text>
            <View style={{ height: spacing.xs }} />
            <Body dim>
              A photo can&apos;t tell how tall you are. This one number is what makes your model
              real-world accurate.
            </Body>
            <View style={{ height: spacing.md }} />
            <View style={styles.inputRow}>
              <TextInput
                value={height}
                onChangeText={setHeight}
                placeholder="178"
                placeholderTextColor={colors.textTertiary}
                keyboardType="number-pad"
                accessibilityLabel="Height in centimetres"
                style={styles.input}
              />
              <Text style={styles.unit}>cm</Text>
              <Button label="Save" onPress={() => void saveHeight()} loading={saving} />
            </View>
            {error ? (
              <>
                <View style={{ height: spacing.sm }} />
                <Caption>{error}</Caption>
              </>
            ) : null}
          </Card>

          <View style={{ height: spacing.md }} />

          {current ? (
            <Card>
              <Text style={styles.heading}>Current body model</Text>
              <View style={{ height: spacing.sm }} />
              {current.quality.overall != null ? (
                <ConfidenceBadge value={current.quality.overall} />
              ) : null}
              <View style={{ height: spacing.sm }} />
              <Caption>
                Version {current.version} · {current.quality.frameCount} frames ·{' '}
                {current.quality.captureMode === 'VIDEO_360' ? 'video' : 'photos'}
              </Caption>
              <View style={{ height: spacing.xs }} />
              <Caption>
                {SCALE_EXPLANATION[current.scale.source] ?? current.scale.source}
              </Caption>
            </Card>
          ) : null}

          {history.data && history.data.length > 1 ? (
            <>
              <View style={{ height: spacing.md }} />
              <Card>
                <Text style={styles.heading}>Scan history</Text>
                <View style={{ height: spacing.sm }} />
                {/* Versioned cores cost ~2 KB each and make "your body over
                    time" possible later at no extra cost. */}
                {history.data.map((core: BodyCore) => (
                  <View key={core.id} style={styles.historyRow}>
                    <Text style={styles.historyVersion}>v{core.version}</Text>
                    <Caption>{new Date(core.createdAt).toLocaleDateString()}</Caption>
                    <View style={{ flex: 1 }} />
                    <Caption>
                      {core.scale.heightCm ? `${Math.round(core.scale.heightCm)} cm` : '—'}
                    </Caption>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          <View style={{ height: spacing.xl }} />

          <Card>
            <Text style={styles.heading}>Your data</Text>
            <View style={{ height: spacing.sm }} />
            <Body dim>
              Photos and video are deleted after 30 days. Your body model is kept until you
              delete it.
            </Body>
            <View style={{ height: spacing.md }} />
            <Button
              label="Download my data"
              variant="secondary"
              onPress={() => void request('/me/export')}
            />
            <View style={{ height: spacing.sm }} />
            <Button label="Delete everything" variant="danger" onPress={confirmDelete} />
          </Card>

          <View style={{ height: spacing.md }} />
          <Button label="Sign out" variant="ghost" onPress={() => void signOut()} />

          <View style={{ height: spacing.md }} />
          <Caption>{user?.email ?? ''}</Caption>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  heading: { ...typography.heading, color: colors.text },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 52,
    minWidth: 90,
  },
  unit: { ...typography.body, color: colors.textSecondary },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  historyVersion: { ...typography.caption, color: colors.text, fontWeight: '700', width: 32 },
});
