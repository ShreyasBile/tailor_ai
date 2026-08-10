import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Caption, Screen, Title } from '../../src/components/ui';
import { useSession } from '../../src/store/session';
import { colors, radius, spacing, typography } from '../../src/theme/tokens';
import { ApiError } from '../../src/lib/api';

export default function SignIn(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { signIn, loading } = useSession();

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await signIn(email.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    }
  };

  return (
    <Screen>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.container}
        >
          <View style={styles.hero}>
            <Title>TailorAI</Title>
            <View style={{ height: spacing.sm }} />
            <Body dim>Your body, measured once. Yours forever.</Body>
          </View>

          <View style={styles.form}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              accessibilityLabel="Email address"
              style={styles.input}
            />

            {error ? <Caption>{error}</Caption> : null}

            <Button
              label="Continue"
              onPress={() => void submit()}
              loading={loading}
              disabled={!email.includes('@')}
            />

            <Caption>
              We only use your email to identify your account. You must be 18 or over.
            </Caption>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, justifyContent: 'space-between', padding: spacing.lg },
  hero: { flex: 1, justifyContent: 'center' },
  form: { gap: spacing.md, paddingBottom: spacing.xl },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 52,
  },
});
