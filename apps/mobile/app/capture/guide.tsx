import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Body, Button, Caption, Card, Screen, Title } from '../../src/components/ui';
import { colors, spacing, typography } from '../../src/theme/tokens';

/**
 * Capture instructions.
 *
 * Worth a full screen: capture quality dominates final accuracy more than any
 * model choice. Thirty seconds of reading here prevents a bad scan that costs
 * three minutes of GPU and a disappointed user (docs/05 §3).
 */
const TIPS: Array<{ title: string; detail: string }> = [
  {
    title: 'Wear fitted clothing',
    detail:
      'Leggings and a t-shirt work well. Loose clothes hide your shape — and please stay clothed.',
  },
  {
    title: 'Find a plain wall',
    detail: 'A clear background makes it much easier for us to find your outline.',
  },
  {
    title: 'Get even light',
    detail: 'Face a window if you can. Avoid harsh shadows and backlighting.',
  },
  {
    title: 'Prop your phone up',
    detail: 'Lean it against something at about waist height, roughly 2 metres away.',
  },
  {
    title: 'Stand in an A-pose',
    detail: 'Feet shoulder-width apart, arms slightly out from your sides so they are separate.',
  },
];

export default function CaptureGuide(): React.JSX.Element {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const isVideo = mode === 'VIDEO_360';

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Before you start</Title>
          <View style={{ height: spacing.md }} />

          {TIPS.map((tip) => (
            <View key={tip.title} style={styles.tip}>
              <Card>
                <Text style={styles.tipTitle}>{tip.title}</Text>
                <View style={{ height: 2 }} />
                <Body dim>{tip.detail}</Body>
              </Card>
            </View>
          ))}

          {isVideo ? (
            <>
              <View style={{ height: spacing.sm }} />
              <Card>
                <Text style={styles.tipTitle}>Turn slowly</Text>
                <View style={{ height: 2 }} />
                <Body dim>
                  Take about 25 seconds for one full circle. Rushing blurs the frames we need.
                </Body>
              </Card>
            </>
          ) : null}

          <View style={{ height: spacing.lg }} />

          <Button
            label={isVideo ? "I'm ready to record" : "I'm ready to shoot"}
            onPress={() => router.push(`/capture/session?mode=${mode}`)}
          />

          <View style={{ height: spacing.md }} />
          <Caption>
            You can retake before anything is uploaded. Nothing leaves your phone until you
            confirm.
          </Caption>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  tip: { marginBottom: spacing.sm },
  tipTitle: { ...typography.callout, color: colors.text, fontWeight: '600' },
});
