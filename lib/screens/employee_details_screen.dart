import 'package:employee_attendance/providers/attendance_provider.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class EmployeeDetailsScreen extends StatefulWidget {
  final String? initialCode;
  const EmployeeDetailsScreen({super.key, this.initialCode});

  @override
  State<EmployeeDetailsScreen> createState() => _EmployeeDetailsScreenState();
}

class _EmployeeDetailsScreenState extends State<EmployeeDetailsScreen> {
  final TextEditingController _codeController = TextEditingController();
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    final init = widget.initialCode?.trim();
    if (init != null && init.isNotEmpty) {
      _codeController.text = init;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _loadEmployee(init);
      });
    }
  }

  Future<void> _loadEmployee(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter employee code')),
      );
      return;
    }
    setState(() => _loading = true);
    try {
      await context.read<AttendanceProvider>().loadEmployee(trimmed);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<AttendanceProvider>();
    final employee = provider.currentEmployee;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Employee Details'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _codeController,
                    decoration: const InputDecoration(
                      labelText: 'Employee Code',
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (v) => _loadEmployee(v),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: _loading
                      ? null
                      : () => _loadEmployee(_codeController.text),
                  child: const Text('Load'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (_loading) const LinearProgressIndicator(),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade400),
                ),
                padding: const EdgeInsets.all(12),
                child: employee == null
                    ? Center(
                        child: Text(
                          'No employee details loaded',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    _detailRow('Employee Code', employee.code),
                                    _detailRow('Employee Name', employee.name),
                                    _detailRow('Designation', employee.designation ?? ''),
                                    _detailRow('Department', employee.department ?? ''),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 16),
                              Container(
                                width: 150,
                                height: 150,
                                color: Colors.grey.shade300,
                                child: employee.imageUrl != null
                                    ? Image.network(
                                        employee.imageUrl!,
                                        fit: BoxFit.cover,
                                        errorBuilder: (context, error, stack) => const Icon(Icons.person, size: 72),
                                      )
                                    : const Icon(Icons.person, size: 72),
                              ),
                            ],
                          ),
                          const SizedBox(height: 16),
                          const Text('Today\'s Times'),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(
                                child: _detailRow(
                                  'Check-In Time',
                                  _formatMaybeTime(context, provider.todayCheckInTime),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: _detailRow(
                                  'Check-Out Time',
                                  _formatMaybeTime(context, provider.todayCheckOutTime),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Widget _detailRow(String label, String value) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        SizedBox(
          width: 150,
          child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        ),
        Expanded(
          child: Container(
            height: 36,
            alignment: Alignment.centerLeft,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: BoxDecoration(
              border: Border.all(color: Colors.grey.shade400),
            ),
            child: Text(value),
          ),
        ),
      ],
    ),
  );
}

String _formatMaybeTime(BuildContext context, DateTime? dt) {
  if (dt == null) return '';
  try {
    return TimeOfDay.fromDateTime(dt).format(context);
  } catch (_) {
    return dt.toLocal().toIso8601String();
  }
}