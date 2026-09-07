import 'package:flutter/foundation.dart';
import '../core/api_client.dart';
import '../core/config.dart';
import '../models/user.dart';

/// Auth, profile and consent — the app's session.
///
/// Biometric consent is treated as a hard gate, mirroring the API which refuses
/// job creation without it. The UI routes on [needsConsent] rather than trusting
/// a checkbox.
class Session extends ChangeNotifier {
  UserProfile? user;
  List<Consent> consents = [];
  bool hydrated = false;
  bool busy = false;

  bool get isAuthed => user != null;

  bool get hasBiometricConsent => consents.any((c) =>
      c.kind == 'BIOMETRIC_PROCESSING' &&
      c.version == Config.biometricConsentVersion &&
      c.granted &&
      c.revokedAt == null);

  bool get needsConsent => isAuthed && !hasBiometricConsent;

  Future<void> hydrate() async {
    try {
      if (await Api.I.hasSession) {
        await _loadUser();
        await _loadConsents();
      }
    } catch (_) {
      await Api.I.clearTokens();
      user = null;
      consents = [];
    } finally {
      hydrated = true;
      notifyListeners();
    }
  }

  Future<void> signIn(String email) async {
    busy = true;
    notifyListeners();
    try {
      final res = await Api.I.post<Map<String, dynamic>>(
        '/auth/session',
        auth: false,
        body: {'token': email.trim()},
      );
      await Api.I.setTokens(
          res['accessToken'] as String, res['refreshToken'] as String);
      user = UserProfile.fromJson(res['user'] as Map<String, dynamic>);
      await _loadConsents();
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    try {
      await Api.I.post('/auth/logout', body: {});
    } catch (_) {}
    await Api.I.clearTokens();
    user = null;
    consents = [];
    notifyListeners();
  }

  Future<void> grantBiometricConsent() async {
    await Api.I.post('/me/consents', body: {
      'kind': 'BIOMETRIC_PROCESSING',
      'version': Config.biometricConsentVersion,
      'granted': true,
    });
    await _loadConsents();
    notifyListeners();
  }

  Future<void> updateHeight(double cm) async {
    final res =
        await Api.I.patch<Map<String, dynamic>>('/me', body: {'heightCm': cm});
    user = UserProfile.fromJson(res);
    notifyListeners();
  }

  Future<void> deleteAccount() async {
    await Api.I.delete('/me');
    await Api.I.clearTokens();
    user = null;
    consents = [];
    notifyListeners();
  }

  Future<void> _loadUser() async {
    user = UserProfile.fromJson(await Api.I.get<Map<String, dynamic>>('/me'));
  }

  Future<void> _loadConsents() async {
    final list = await Api.I.get<List<dynamic>>('/me/consents');
    consents = list
        .cast<Map<String, dynamic>>()
        .map(Consent.fromJson)
        .toList();
  }
}
