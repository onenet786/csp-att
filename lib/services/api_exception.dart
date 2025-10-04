class ApiException implements Exception {
  final int statusCode;
  final String message;
  final Map<String, dynamic>? body;

  ApiException(this.statusCode, this.message, [this.body]);

  @override
  String toString() {
    final bodyStr = body == null ? '' : ' $body';
    return 'ApiException($statusCode): $message$bodyStr';
  }
}