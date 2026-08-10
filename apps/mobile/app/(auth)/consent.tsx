import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Caption, Card, Screen, Title } from '../../src/components/ui';
import { useSession } from '../../src/store/session';
import { colors, spacing, typography } from '../../src/theme/tokens';
import { Text } from 'react-native';

/**
 * Biometric consent.
 *
 * This screen is a legal control, not a formality. BIPA requires informed
 * written consent *before* collection, with a published retention schedule,
 * and the ability to prove years later what was agreed. So it states plainly
 * what we collect, what we keep, for how long, and what we never do — in
 * language a person can actually read (docs/06 §6.1).
 */
export default function ConsentScreen(): React.JSX.Element {
  const { grantBiometricConsent, signOut } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await grantBiometricConsent();
    } catch {
      setError('Could not save your choice. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Before we begin</Title>
          <View style={{ height: spacing.md }} />
          <Body dim>
            Building a 3D model of your body means processing biometric data. Here is exactly
            what that involves.
          </Body>

          <View style={{ height: spacing.lg }} />

          <Card>
            <Text style={styles.heading}>What we collect</Text>
            <Body>The photos or video you capture, and the body measurements derived from them.</Body>
          </Card>

          <View style={{ height: spacing.md }} />

          <Card>
            <Text style={styles.heading}>What we keep, and for how long</Text>
            <Body>
              Your photos and video are deleted after 30 days. Your body model — a small set of
              numbers describing your proportions — is kept until you delete it.
            </Body>
          </Card>

          <View style={{ height: spacing.md }} />

          <Card>
            <Text style={styles.heading}>What we never do</Text>
            <Body>
              We do not sell your data, share it with advertisers, or use it to train models
              without asking you separately.
            </Body>
          </Card>

          <View style={{ height: spacing.md }} />

          <Card>
            <Text style={styles.heading}>Your control</Text>
            <Body>
              You can download everything we hold, or delete your account and all of its data,
              at any time from Settings.
            </Body>
          </Card>

          <View style={{ height: spacing.lg }} />

          <Caption>
            Please wear fitted clothing such as leggings and a t-shirt when you capture. It gives
            a better result, and we do not want images of you in underwear. You must be 18 or over.
          </Caption>

          <View style={{ height: spacing.lg }} />

          {error ? <Caption>{error}</Caption> : null}

          <Button
            label="I agree — process my body scans"
            onPress={() => void accept()}
            loading={submitting}
          />
          <View style={{ height: spacing.sm }} />
          <Button label="Not now" variant="ghost" onPress={() => void signOut()} />
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  heading: {
    ...typography.heading,
    color: colors.text,
    marginBottom: spacing.xs,
  },
});
