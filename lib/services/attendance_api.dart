import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/models/employee.dart';
import 'package:employee_attendance/services/api_client.dart';

class AttendanceApi {
  final ApiClient _client;
  AttendanceApi(this._client);

  Future<Employee?> fetchEmployeeByCode(String code) async {
    try {
      final res = await _client.getJson('/employees/$code');
      if (res['employee'] == null) return null;
      return Employee.fromJson(res['employee'] as Map<String, dynamic>);
    } catch (_) {
      // On network/API errors, treat as not found and continue
      return null;
    }
  }

  Future<Map<String, dynamic>> markAttendance(AttendanceRecord record) async {
    return _client.postJson('/attendance/mark', record.toJson());
  }

  Future<Map<String, dynamic>> fetchStatusByCode(String code) async {
    return _client.getJson('/attendance/status/$code');
  }

  Future<Map<String, dynamic>> fetchEmployeeAttendanceTimes(String code) async {
    return _client.getJson('/employees/$code/attendance-times');
  }
}

