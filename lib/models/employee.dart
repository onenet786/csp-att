class Employee {
  final String code;
  final String name;
  final String? designation;
  final String? department;
  final String? imageUrl;

  const Employee({
    required this.code,
    required this.name,
    this.designation,
    this.department,
    this.imageUrl,
  });

  factory Employee.fromJson(Map<String, dynamic> json) {
    return Employee(
      code: json['code']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      designation: json['designation']?.toString(),
      department: json['department']?.toString(),
      imageUrl: json['imageUrl']?.toString(),
    );
  }
}

