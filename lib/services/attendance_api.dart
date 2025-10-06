import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/models/employee.dart';
import 'package:employee_attendance/services/api_client.dart';

class AttendanceApi {
  final ApiClient _client;
  AttendanceApi(this._client);

  String _sanitizeCode(String code) {
    final trimmed = code.trim();
    // Remove leading non-alphanumeric characters (e.g., leading '/')
    return trimmed.replaceFirst(RegExp(r'^[^A-Za-z0-9]+'), '');
  }

  Future<Employee?> fetchEmployeeByCode(String code) async {
    try {
      final normalized = _sanitizeCode(code);
      final res = await _client.getJson('/employees/$normalized');
      if (res['employee'] == null) return null;
      return Employee.fromJson(res['employee'] as Map<String, dynamic>);
    } catch (_) {
      // On network/API errors, treat as not found and continue
      return null;
    }
  }

  Future<Map<String, dynamic>> markAttendance(AttendanceRecord record) async {
    final payload = {
      ...record.toJson(),
      'employeeCode': _sanitizeCode(record.employeeCode),
    };
    return _client.postJson('/attendance/mark', payload);
  }

  Future<Map<String, dynamic>> fetchStatusByCode(String code) async {
    final normalized = _sanitizeCode(code);
    return _client.getJson('/attendance/status/$normalized');
  }

  Future<Map<String, dynamic>> fetchEmployeeAttendanceTimes(String code) async {
    final normalized = _sanitizeCode(code);
    return _client.getJson('/employees/$normalized/attendance-times');
  }
}

