class Employee {
  final String code;
  final String name;
  final String? designation;
  final String? department;
  final String? employeeSubGroupName;
  final String? imageUrl;

  const Employee({
    required this.code,
    required this.name,
    this.designation,
    this.department,
    this.employeeSubGroupName,
    this.imageUrl,
  });

  factory Employee.fromJson(Map<String, dynamic> json) {
    return Employee(
      code: json['code']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      designation: json['designation']?.toString(),
      department: json['department']?.toString(),
      employeeSubGroupName: json['employee_sub_group_name']?.toString() ??
          json['employeeSubGroupName']?.toString(),
      imageUrl: json['imageUrl']?.toString(),
    );
  }

  String get displayDepartment {
    if (employeeSubGroupName != null &&
        employeeSubGroupName!.trim().isNotEmpty &&
        employeeSubGroupName != '-') {
      return employeeSubGroupName!;
    }
    if (department != null &&
        department!.trim().isNotEmpty &&
        department != '-') {
      return department!;
    }
    return '';
  }
}
