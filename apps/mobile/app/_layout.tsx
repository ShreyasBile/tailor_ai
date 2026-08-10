import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { View, ActivityIndicator } from 'react-native';
import { useSession } from '../src/store/session';
import { colors } from '../src/theme/tokens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mobile networks are hostile; retry reads but don't hammer.
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, consents, hydrated, hydrate, hasBiometricConsent } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;

    const inAuthGroup = segments[0] === '(auth)';
    // Guard on the consent *screen*, not the whole (auth) group. Guarding the
    // group looks like it prevents a redirect loop, but it also blocks the
    // sign-in → consent hop — and that hop is the only route by which a new
    // user ever reaches the consent screen. Signing in then left you on
    // sign-in with nothing happening.
    const onConsentScreen = inAuthGroup && segments[1] === 'consent';

    if (!user) {
      if (!inAuthGroup) router.replace('/(auth)/sign-in');
      return;
    }

    // Biometric consent is a blocking gate, not a settings toggle. The API
    // refuses job creation without it, so routing past this screen would
    // guarantee a 403 later (docs/06 §6.1).
    if (!hasBiometricConsent()) {
      if (!onConsentScreen) router.replace('/(auth)/consent');
      return;
    }

    if (inAuthGroup) router.replace('/(tabs)');
    // `consents` must be a dependency: hasBiometricConsent is a stable store
    // method, so without it this effect would not re-run when consent is
    // granted and the consent screen would hang the same way.
  }, [user, consents, hydrated, segments, router, hasBiometricConsent]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <AuthGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'slide_from_right',
              }}
            >
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="capture" />
              <Stack.Screen
                name="processing/[id]"
                options={{ gestureEnabled: false }}
              />
              <Stack.Screen name="viewer/[id]" options={{ animation: 'fade' }} />
            </Stack>
          </AuthGate>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
