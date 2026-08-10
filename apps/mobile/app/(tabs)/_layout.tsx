import { Tabs } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';
import { colors, typography } from '../../src/theme/tokens';

function TabIcon({ label, focused }: { label: string; focused: boolean }): React.JSX.Element {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.45 }} accessibilityElementsHidden>
      {label}
    </Text>
  );
}

export default function TabsLayout(): React.JSX.Element {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 84,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarLabelStyle: { ...typography.caption, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon label="◉" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => <TabIcon label="◈" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
