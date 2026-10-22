/// Runtime configuration.
///
/// Defaults to the LAN address of the dev machine, which is already proven to
/// serve the phone over Wi-Fi (the API's presigned URLs also point here, so the
/// 3D viewer's GLB loads without extra wiring). Override at build time with:
///   flutter run --dart-define=API_BASE=http://10.0.2.2:3000
/// (10.0.2.2 is the host loopback from the Android emulator; for a USB device
/// with `adb reverse tcp:3000 tcp:3000` use http://localhost:3000.)
class Config {
  static const apiBase = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'http://192.168.0.108:3000',
  );

  static String get apiV1 => '$apiBase/v1';

  /// Consent document version. Must match the API's CONSENT_VERSIONS.
  static const biometricConsentVersion = 'biometric-v1';

  static const minAge = 18;
}
