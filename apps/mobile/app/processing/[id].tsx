import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Body, Button, Caption, Screen, Title } from '../../src/components/ui';
import { STAGE_LABELS, useJobStream } from '../../src/lib/jobStream';
import { colors, radius, spacing, typography, motion } from '../../src/theme/tokens';

/**
 * The waiting screen.
 *
 * Two to three minutes of waiting decides whether this feels like progress or
 * abandonment. So: real stage names from the server's actual stage feed, never
 * a synthetic timer. If texturing takes 60 seconds, the bar sits in texturing
 * and says so. A progress bar that lies is worse than no progress bar.
 */
export default function Processing(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const job = useJobStream(id ?? null);

  const progress = useSharedValue(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    progress.value = withSpring(job.progress, motion.slow);
  }, [job.progress, progress]);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(1.06, { duration: 1100 }), withTiming(1, { duration: 1100 })),
      -1,
      true,
    );
  }, [pulse]);

  useEffect(() => {
    if (job.status === 'COMPLETED' && job.result) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/viewer/${job.result.renderId}`);
    }
  }, [job.status, job.result, router]);

  useEffect(() => {
    if (job.status === 'FAILED') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [job.status]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${Math.max(2, progress.value * 100)}%`,
  }));

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  if (job.status === 'FAILED' && job.error) {
    return (
      <Screen>
        <SafeAreaView style={styles.centered}>
          <Text style={styles.errorGlyph}>◍</Text>
          <View style={{ height: spacing.lg }} />
          <Title>That didn&apos;t work</Title>
          <View style={{ height: spacing.sm }} />
          {/* The server's message is written for a person and names the fix. */}
          <Body dim>{job.error.message}</Body>

          <View style={{ height: spacing.xl }} />
          <Button label="Try another scan" onPress={() => router.replace('/capture/intro')} />
          <View style={{ height: spacing.sm }} />
          <Button label="Back to home" variant="ghost" onPress={() => router.replace('/(tabs)')} />
        </SafeAreaView>
      </Screen>
    );
  }

  if (job.status === 'CANCELLED') {
    return (
      <Screen>
        <SafeAreaView style={styles.centered}>
          <Title>Scan cancelled</Title>
          <View style={{ height: spacing.lg }} />
          <Button label="Back to home" onPress={() => router.replace('/(tabs)')} />
        </SafeAreaView>
      </Screen>
    );
  }

  const label = job.stage ? (STAGE_LABELS[job.stage] ?? 'Working') : 'Getting started';

  return (
    <Screen>
      <SafeAreaView style={styles.centered}>
        <Animated.View style={[styles.orb, orbStyle]} />

        <View style={{ height: spacing.xl }} />

        <Title>Building your model</Title>
        <View style={{ height: spacing.sm }} />

        <View accessibilityLiveRegion="polite">
          <Body dim>{label}</Body>
        </View>

        <View style={{ height: spacing.lg }} />

        <View style={styles.track}>
          <Animated.View style={[styles.fill, barStyle]} />
        </View>

        <View style={{ height: spacing.sm }} />
        <Caption>{Math.round(job.progress * 100)}%</Caption>

        <View style={{ height: spacing.xl }} />
        <Caption>
          You can leave this screen — we&apos;ll notify you when it&apos;s ready.
        </Caption>

        <View style={{ height: spacing.md }} />
        <Button label="Back to home" variant="ghost" onPress={() => router.replace('/(tabs)')} />
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  orb: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.accentSubtle,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  track: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3 },
  errorGlyph: { fontSize: 48, color: colors.danger },
  stageText: { ...typography.callout, color: colors.textSecondary },
  radiusRef: { borderRadius: radius.sm },
});
