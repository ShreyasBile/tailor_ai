import { Redirect } from 'expo-router';
import React from 'react';

/** Root entry. AuthGate in _layout decides where the user actually lands. */
export default function Index(): React.JSX.Element {
  return <Redirect href="/(tabs)" />;
}
