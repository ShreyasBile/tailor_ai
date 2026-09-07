import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'config.dart';
import 'api_error.dart';

/// Typed API client.
///
/// Handles the three things every request needs: bearer auth, transparent token
/// refresh on 401 (collapsing concurrent refreshes so a single-use refresh
/// token is not burned twice), and mapping the API's RFC 9457 problem responses
/// into a typed [ApiError]. Also enforces a request timeout — on a phone, wrong
/// Wi-Fi and captive portals are normal, and a silent hang is the worst outcome.
class Api {
  Api._();
  static final Api I = Api._();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _accessKey = 'tailorai.access';
  static const _refreshKey = 'tailorai.refresh';
  static const _timeout = Duration(seconds: 20);

  final _client = http.Client();
  Future<bool>? _refreshInFlight;

  Future<String?> get accessToken => _storage.read(key: _accessKey);
  Future<String?> get refreshToken => _storage.read(key: _refreshKey);

  Future<void> setTokens(String access, String refresh) async {
    await _storage.write(key: _accessKey, value: access);
    await _storage.write(key: _refreshKey, value: refresh);
  }

  Future<void> clearTokens() async {
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }

  Future<bool> get hasSession async => (await accessToken) != null;

  Future<T> get<T>(String path, {bool auth = true}) =>
      _send<T>('GET', path, auth: auth);

  Future<T> post<T>(String path,
          {Object? body, bool auth = true, String? idempotencyKey}) =>
      _send<T>('POST', path, body: body, auth: auth, idempotencyKey: idempotencyKey);

  Future<T> patch<T>(String path, {Object? body}) =>
      _send<T>('PATCH', path, body: body);

  Future<void> delete(String path) => _send<void>('DELETE', path);

  Future<T> _send<T>(String method, String path,
      {Object? body,
      bool auth = true,
      String? idempotencyKey,
      bool retryOn401 = true}) async {
    final headers = <String, String>{'content-type': 'application/json'};
    if (auth) {
      final t = await accessToken;
      if (t != null) headers['authorization'] = 'Bearer $t';
    }
    if (idempotencyKey != null) headers['idempotency-key'] = idempotencyKey;

    final uri = Uri.parse('${Config.apiV1}$path');
    late http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      final streamed = await _client.send(req).timeout(_timeout);
      res = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiError('TIMEOUT', 0, true,
          "That took too long. Check you're on the same Wi-Fi and try again.");
    } catch (_) {
      throw ApiError('NETWORK_ERROR', 0, true,
          "Couldn't reach the server. Check your connection and try again.");
    }

    if (res.statusCode == 401 && retryOn401 && auth) {
      if (await _refresh()) {
        return _send<T>(method, path,
            body: body, auth: auth, idempotencyKey: idempotencyKey, retryOn401: false);
      }
    }

    if (res.statusCode >= 400) throw _problem(res);
    if (res.statusCode == 204 || res.body.isEmpty) return null as T;
    return jsonDecode(res.body) as T;
  }

  ApiError _problem(http.Response res) {
    try {
      final p = jsonDecode(res.body) as Map<String, dynamic>;
      return ApiError(
        (p['code'] ?? 'INTERNAL_ERROR') as String,
        res.statusCode,
        (p['retryable'] ?? false) as bool,
        (p['detail'] ?? 'Something went wrong.') as String,
      );
    } catch (_) {
      return ApiError('INTERNAL_ERROR', res.statusCode, res.statusCode >= 500,
          'Something went wrong.');
    }
  }

  Future<bool> _refresh() {
    return _refreshInFlight ??= () async {
      try {
        final rt = await refreshToken;
        if (rt == null) return false;
        final res = await _client
            .post(Uri.parse('${Config.apiV1}/auth/refresh'),
                headers: {'content-type': 'application/json'},
                body: jsonEncode({'refreshToken': rt}))
            .timeout(_timeout);
        if (res.statusCode >= 400) {
          await clearTokens();
          return false;
        }
        final d = jsonDecode(res.body) as Map<String, dynamic>;
        await setTokens(d['accessToken'] as String, d['refreshToken'] as String);
        return true;
      } catch (_) {
        return false;
      } finally {
        _refreshInFlight = null;
      }
    }();
  }
}
