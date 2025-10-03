enum AttendanceType { inScan, outScan }

class AttendanceRecord {
  final String employeeCode;
  final DateTime timestamp;
  final String reason;
  final AttendanceType type;
  final String? remarks;

  const AttendanceRecord({
    required this.employeeCode,
    required this.timestamp,
    required this.reason,
    required this.type,
    this.remarks,
  });

  Map<String, dynamic> toJson() {
    return {
      'employeeCode': employeeCode,
      'timestamp': timestamp.toIso8601String(),
      'reason': reason,
      'type': type.name,
      'remarks': remarks,
    };
  }
}

