import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/models/employee.dart';
import 'package:employee_attendance/services/attendance_api.dart';
import 'package:flutter/foundation.dart';
import 'package:employee_attendance/services/api_exception.dart';

class AttendanceProvider extends ChangeNotifier {
  final AttendanceApi api;

  AttendanceProvider({required this.api});

  Employee? currentEmployee;
  bool isSubmitting = false;
  String? errorMessage;

  Future<void> loadEmployee(String code) async {
    errorMessage = null;
    try {
      currentEmployee = await api.fetchEmployeeByCode(code);
    } catch (e) {
      // Swallow errors; marking can proceed with code only
      currentEmployee = currentEmployee; // no-op to satisfy lints
    }
    notifyListeners();
  }

  Future<bool> submitAttendance(AttendanceRecord record) async {
    isSubmitting = true;
    errorMessage = null;
    notifyListeners();
    try {
      await api.markAttendance(record);
      return true;
    } catch (e) {
      if (e is ApiException) {
        // Prefer backend-provided error message, with status code context
        final backendMsg = e.body?['error']?.toString() ?? e.body?['message']?.toString();
        errorMessage = backendMsg != null
            ? 'Error ${e.statusCode}: $backendMsg'
            : 'Error ${e.statusCode}: ${e.message}';
      } else {
        errorMessage = e.toString();
      }
      return false;
    } finally {
      isSubmitting = false;
      notifyListeners();
    }
  }
}

