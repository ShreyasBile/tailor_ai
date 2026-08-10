/**
 * Viewer selection.
 *
 * Two implementations exist behind one import, because the renderer is meant
 * to be replaceable (docs/05 §1):
 *
 *   ThreeViewer            expo-gl + three.js. Pure JS, so it runs in Expo Go
 *                          — which is what makes device testing possible
 *                          without a native build, a Mac, or a paid Apple
 *                          Developer account. Renders geometry correctly;
 *                          cannot decode GLB-embedded textures, because
 *                          three.js reaches for browser APIs React Native
 *                          does not have.
 *
 *   AvatarViewer.filament  react-native-filament. Metal/Vulkan, renders off
 *                          the JS thread, handles textures natively. The
 *                          production path — requires a dev-client build.
 *
 * ThreeViewer is exported because Metro bundles only what is imported: naming
 * the Filament module here would pull its native bindings into the Expo Go
 * bundle and break it at startup. To switch, change this one line and build a
 * dev client.
 */
export { ThreeViewer as AvatarViewer } from './ThreeViewer';
export type { RenderMode, LightPreset } from './ThreeViewer';
