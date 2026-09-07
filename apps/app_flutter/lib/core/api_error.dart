/// Carries the backend's taxonomy code so screens can offer the right recovery.
class ApiError implements Exception {
  final String code;
  final int status;
  final bool retryable;
  final String message;
  ApiError(this.code, this.status, this.retryable, this.message);

  bool get isNotFound => status == 404;

  @override
  String toString() => 'ApiError($code, $status): $message';
}
