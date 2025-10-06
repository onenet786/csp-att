import 'dart:convert';

import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;
import 'api_exception.dart';

class ApiClient {
  ApiClient();

  String get _baseUrl =>
      dotenv.env['API_BASE_URL']?.trim() ?? 'http://localhost:3000';

  Uri _uri(String path) => Uri.parse('$_baseUrl$path');

  Future<Map<String, dynamic>> getJson(String path) async {
    final response = await http.get(_uri(path));
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return json.decode(response.body) as Map<String, dynamic>;
    }
    Map<String, dynamic>? body;
    try {
      body = json.decode(response.body) as Map<String, dynamic>;
    } catch (_) {}
    throw ApiException(
      response.statusCode,
      body != null
          ? (body['error']?.toString() ??
              body['message']?.toString() ??
              'GET failed')
          : 'GET $path failed',
      body,
    );
  }

  Future<Map<String, dynamic>> postJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await http.post(
      _uri(path),
      headers: const {'Content-Type': 'application/json'},
      body: json.encode(body),
    );
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return json.decode(response.body) as Map<String, dynamic>;
    }
    Map<String, dynamic>? err;
    try {
      err = json.decode(response.body) as Map<String, dynamic>;
    } catch (_) {}
    throw ApiException(
      response.statusCode,
      err != null
          ? (err['error']?.toString() ??
              err['message']?.toString() ??
              'POST failed')
          : 'POST $path failed',
      err,
    );
  }
}
