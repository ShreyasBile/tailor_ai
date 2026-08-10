import type { ExpoConfig } from 'expo/config';

/**
 * A dev client, not Expo Go: the camera frame processors and the Filament
 * renderer are native modules that Expo Go cannot load.
 */
const config: ExpoConfig = {
  name: 'TailorAI',
  slug: 'tailorai',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'tailorai',
  userInterfaceStyle: 'dark',
  // The New Architecture is the default from SDK 55 onward; declaring it is
  // now an error.

  ios: {
    supportsTablet: false,
    bundleIdentifier: 'app.tailorai.mobile',
    infoPlist: {
      // Permission copy is user-facing and must say what we do with the data.
      // Vague strings get rejected in review and, more importantly, are the
      // first thing a user reads before handing over a body scan.
      NSCameraUsageDescription:
        'TailorAI uses your camera to capture the photos or video used to build your 3D body model.',
      NSPhotoLibraryUsageDescription:
        'TailorAI needs access to your photos so you can upload existing images for your body model.',
      NSMotionUsageDescription:
        'TailorAI uses motion data to check your phone is upright during capture.',
    },
  },

  android: {
    package: 'app.tailorai.mobile',
    adaptiveIcon: { backgroundColor: '#0A0A0B' },
    permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
  },

  // Only packages that actually ship a config plugin belong here. expo-image,
  // expo-asset, expo-sharing and expo-status-bar are plain libraries on SDK 54
  // and listing them fails the build with "does not appear to be a config
  // plugin".
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-splash-screen', { backgroundColor: '#0A0A0B', resizeMode: 'contain' }],
    [
      'expo-camera',
      {
        cameraPermission:
          'TailorAI uses your camera to capture the photos or video used to build your 3D body model.',
      },
    ],
  ],

  experiments: { typedRoutes: true },

  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default config;
