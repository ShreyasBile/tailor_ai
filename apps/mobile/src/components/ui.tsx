import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, spacing, typography } from '../theme/tokens';

/** Design-system primitives. Small on purpose — variety here is a cost, not a feature. */

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const isDisabled = disabled || loading;

  const bg =
    variant === 'primary'
      ? colors.accent
      : variant === 'danger'
        ? colors.danger
        : variant === 'secondary'
          ? colors.surfaceRaised
          : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      onPress={() => {
        // Haptics only on meaningful state changes, never as decoration.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg },
        variant === 'ghost' && styles.ghost,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === 'ghost' && { color: colors.textSecondary },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Screen({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  dim,
}: {
  children: React.ReactNode;
  dim?: boolean;
}): React.JSX.Element {
  return <Text style={[styles.body, dim && { color: colors.textSecondary }]}>{children}</Text>;
}

export function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.caption}>{children}</Text>;
}

/**
 * Surfaces a quality or confidence figure without pretending to precision.
 * Used wherever the product reports what it knows about its own output.
 */
export function ConfidenceBadge({ value }: { value: number }): React.JSX.Element {
  const level = value >= 0.75 ? 'High' : value >= 0.5 ? 'Moderate' : 'Low';
  const tint = value >= 0.75 ? colors.success : value >= 0.5 ? colors.warning : colors.danger;

  return (
    <View style={[styles.badge, { borderColor: tint }]}>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text style={[styles.badgeText, { color: tint }]}>{level} confidence</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  ghost: { borderWidth: 1, borderColor: colors.border },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.4 },
  buttonLabel: { ...typography.callout, color: colors.text, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  title: { ...typography.title, color: colors.text },
  body: { ...typography.body, color: colors.text },
  caption: { ...typography.caption, color: colors.textTertiary },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { ...typography.caption, fontWeight: '600' },
});
