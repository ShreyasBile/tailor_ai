import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Body, Caption, Card, Screen, Title } from '../../src/components/ui';
import { colors, spacing, typography } from '../../src/theme/tokens';

export default function CaptureIntro(): React.JSX.Element {
  const router = useRouter();

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>How would you like to scan?</Title>
          <View style={{ height: spacing.sm }} />
          <Body dim>Video gives a noticeably better result — we see you from every side.</Body>

          <View style={{ height: spacing.lg }} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record a 360 degree video, recommended"
            onPress={() => router.push('/capture/guide?mode=VIDEO_360')}
          >
            <Card style={styles.option}>
              <View style={styles.optionHeader}>
                <Text style={styles.optionTitle}>Record a slow turn</Text>
                <View style={styles.pill}>
                  <Text style={styles.pillText}>Recommended</Text>
                </View>
              </View>
              <View style={{ height: spacing.xs }} />
              <Body dim>
                About 25 seconds. Turn slowly all the way around while your phone is propped up.
              </Body>
            </Card>
          </Pressable>

          <View style={{ height: spacing.md }} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take four photos"
            onPress={() => router.push('/capture/guide?mode=PHOTO_SET')}
          >
            <Card style={styles.option}>
              <Text style={styles.optionTitle}>Take photos</Text>
              <View style={{ height: spacing.xs }} />
              <Body dim>
                Four shots: front, right, back, left. Quicker, but slightly less accurate.
              </Body>
            </Card>
          </Pressable>

          <View style={{ height: spacing.lg }} />
          <Caption>
            Either way, wear fitted clothing and stand against a plain wall with good light.
          </Caption>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  option: { paddingVertical: spacing.lg },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionTitle: { ...typography.heading, color: colors.text },
  pill: {
    backgroundColor: colors.accentSubtle,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  pillText: { ...typography.caption, color: colors.accent, fontWeight: '600' },
});
