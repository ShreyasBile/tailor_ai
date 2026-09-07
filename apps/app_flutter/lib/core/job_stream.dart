import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'api_client.dart';
import 'config.dart';

/// A single progress snapshot for the processing screen.
class JobProgress {
  final String status;
  final String? stage;
  final double progress;
  final Map<String, String>? result; // {bodyCoreId, renderId}
  final String? errorCode;
  final String? errorMessage;
  JobProgress({
    required this.status,
    this.stage,
    required this.progress,
    this.result,
    this.errorCode,
    this.errorMessage,
  });
}

bool _isTerminal(String s) =>
    s == 'COMPLETED' || s == 'FAILED' || s == 'CANCELLED';

/// Live job progress over Server-Sent Events, with a polling fallback.
///
/// Mobile connections drop constantly, so on any stream failure this silently
/// degrades to polling GET /jobs/:id. The user just sees progress.
class JobStream {
  final String jobId;
  final _controller = StreamController<JobProgress>.broadcast();
  http.Client? _client;
  Timer? _poll;
  bool _closed = false;

  JobStream(this.jobId);

  Stream<JobProgress> get stream => _controller.stream;

  Future<void> start() async {
    try {
      await _stream();
    } catch (_) {
      _startPolling();
    }
  }

  Future<void> _stream() async {
    final token = await Api.I.accessToken;
    _client = http.Client();
    final url =
        '${Config.apiV1}/jobs/$jobId/events?access_token=${token ?? ''}';
    final req = http.Request('GET', Uri.parse(url))
      ..headers['accept'] = 'text/event-stream';
    final res = await _client!.send(req).timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw Exception('sse ${res.statusCode}');
    }

    var buffer = '';
    await for (final chunk in res.stream.transform(utf8.decoder)) {
      if (_closed) return;
      buffer += chunk;
      final frames = buffer.split('\n\n');
      buffer = frames.removeLast();
      for (final frame in frames) {
        String? data;
        for (final line in frame.split('\n')) {
          if (line.startsWith('data:')) {
            data = line.substring(5).trim();
          }
        }
        if (data == null || data.isEmpty) continue;
        final done = _emit(jsonDecode(data) as Map<String, dynamic>);
        if (done) {
          await close();
          return;
        }
      }
    }
  }

  void _startPolling() {
    _poll = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (_closed) return;
      try {
        final j = await Api.I.get<Map<String, dynamic>>('/jobs/$jobId');
        final stages =
            (j['stages'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
        final running = stages.firstWhere(
          (s) => s['status'] == 'RUNNING',
          orElse: () => const <String, dynamic>{},
        );
        final result = j['result'];
        _controller.add(JobProgress(
          status: j['status'] as String,
          stage: running['name'] as String?,
          progress: (j['progress'] as num?)?.toDouble() ?? 0,
          result: result is Map<String, dynamic>
              ? {
                  'bodyCoreId': result['bodyCoreId'] as String,
                  'renderId': result['renderId'] as String,
                }
              : null,
          errorCode: j['errorCode'] as String?,
          errorMessage: j['errorMessage'] as String?,
        ));
        if (_isTerminal(j['status'] as String)) await close();
      } catch (_) {
        // keep polling
      }
    });
  }

  bool _emit(Map<String, dynamic> e) {
    switch (e['event']) {
      case 'stage':
        _controller.add(JobProgress(
          status: e['jobStatus'] as String,
          stage: e['stage'] as String?,
          progress: (e['progress'] as num).toDouble(),
        ));
        return false;
      case 'completed':
        _controller.add(JobProgress(
          status: 'COMPLETED',
          progress: 1,
          result: {
            'bodyCoreId': e['bodyCoreId'] as String,
            'renderId': e['renderId'] as String,
          },
        ));
        return true;
      case 'failed':
        _controller.add(JobProgress(
          status: 'FAILED',
          progress: 0,
          errorCode: e['errorCode'] as String?,
          errorMessage: e['errorMessage'] as String?,
        ));
        return true;
      case 'cancelled':
        _controller.add(JobProgress(status: 'CANCELLED', progress: 0));
        return true;
    }
    return false;
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _poll?.cancel();
    _client?.close();
    if (!_controller.isClosed) await _controller.close();
  }
}
