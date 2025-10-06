import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/models/employee.dart';
import 'package:employee_attendance/services/attendance_api.dart';
import 'package:flutter/foundation.dart';

class AttendanceProvider extends ChangeNotifier {
  final AttendanceApi api;

  AttendanceProvider({required this.api});

  Employee? currentEmployee;
  bool isSubmitting = false;
  String? errorMessage;
  DateTime? todayCheckInTime;
  DateTime? todayCheckOutTime;

  Future<void> loadEmployee(String code) async {
    errorMessage = null;
    currentEmployee = await api.fetchEmployeeByCode(code);
    notifyListeners();
  }

  Future<bool> submitAttendance(AttendanceRecord record) async {
    isSubmitting = true;
    errorMessage = null;
    notifyListeners();
    try {
      await api.markAttendance(record);
      
      // Update check-in or check-out time based on record type
      if (record.type == AttendanceType.inScan) {
        todayCheckInTime = DateTime.now();
      } else if (record.type == AttendanceType.outScan) {
        todayCheckOutTime = DateTime.now();
      }
      
      return true;
    } catch (e) {
      errorMessage = e.toString();
      return false;
    } finally {
      isSubmitting = false;
      notifyListeners();
    }
  }
  
  void setCheckInTime(DateTime? time) {
    todayCheckInTime = time;
    notifyListeners();
  }
  
  void setCheckOutTime(DateTime? time) {
    todayCheckOutTime = time;
    notifyListeners();
  }
}

