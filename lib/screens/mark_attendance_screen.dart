import 'dart:async';
import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/providers/attendance_provider.dart';
import 'package:flutter/material.dart';
// local_auth removed due to unused thumb scan
// mobile_scanner removed due to unused QR tab
import 'package:provider/provider.dart';

class MarkAttendanceScreen extends StatefulWidget {
  const MarkAttendanceScreen({super.key});

  @override
  State<MarkAttendanceScreen> createState() => _MarkAttendanceScreenState();
}

class _MarkAttendanceScreenState extends State<MarkAttendanceScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController = TabController(
    length: 3,
    vsync: this,
  );
  final TextEditingController _codeController = TextEditingController();
  // LocalAuthentication removed due to unused thumb scan
  final List<AttendanceRecord> _recentMarks = <AttendanceRecord>[];
  Timer? _clockTimer;
  DateTime _now = DateTime.now();
  AttendanceType? _lastType;

  @override
  void dispose() {
    _tabController.dispose();
    _codeController.dispose();
    _clockTimer?.cancel();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        _now = DateTime.now();
      });
    });
  }

  Future<bool> _handleSubmit(
    String code,
    AttendanceType type,
  ) async {
    final provider = context.read<AttendanceProvider>();
    await provider.loadEmployee(code);
    // Proceed even if employee not found; backend will map numeric codes
    if (provider.currentEmployee == null && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(
        const SnackBar(
          content: Text('Proceeding without employee details'),
        ),
      );
    }
    final record = AttendanceRecord(
      employeeCode: code,
      timestamp: DateTime.now(),
      reason: 'Duty',
      type: type,
    );
    final ok = await provider.submitAttendance(record);
    if (!mounted) return false;
    if (ok) {
      setState(() {
        _lastType = type;
        _recentMarks.insert(0, record);
        if (_recentMarks.length > 10) {
          _recentMarks.removeLast();
        }
      });
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ok
              ? 'Attendance marked'
              : provider.errorMessage ?? 'Failed to mark attendance',
        ),
      ),
    );
    return ok;
  }


  

  @override
  Widget build(BuildContext context) {
    final isLoading = context.watch<AttendanceProvider>().isSubmitting;
    final employee = context.watch<AttendanceProvider>().currentEmployee;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Terminal Attendance'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Center(
              child: Text(
                '${_now.toLocal().toString().split(' ').first}  ${TimeOfDay.fromDateTime(_now).format(context)}',
              ),
            ),
          ),
        ],
      ),
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                Row(
                  children: [
                    SizedBox(
                      width: 340,
                      child: Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _codeController,
                              decoration: const InputDecoration(
                                labelText: 'Enter Employee Code',
                                border: OutlineInputBorder(),
                              ),
                              onSubmitted: (_) => _handleSubmit(
                                _codeController.text.trim(),
                                AttendanceType.inScan,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          ElevatedButton(
                            onPressed: () => _handleSubmit(
                              _codeController.text.trim(),
                              AttendanceType.inScan,
                            ),
                            child: const Text('Mark'),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Text(
                        'Attendance Marked',
                        style: Theme.of(context)
                            .textTheme
                            .titleLarge
                            ?.copyWith(color: Colors.green[700]),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Left grid
                      Expanded(
                        child: Container(
                          decoration: BoxDecoration(
                            border: Border.all(color: Colors.grey.shade400),
                          ),
                          child: SingleChildScrollView(
                            child: DataTable(
                              columns: const [
                                DataColumn(label: Text('Time')),
                                DataColumn(label: Text('Reason')),
                                DataColumn(label: Text('Type')),
                                DataColumn(label: Text('Duration')),
                                DataColumn(label: Text('Allowed')),
                                DataColumn(label: Text('Remarks')),
                              ],
                              rows: _recentMarks
                                  .map(
                                    (r) => DataRow(cells: [
                                      DataCell(Text(
                                          TimeOfDay.fromDateTime(r.timestamp)
                                              .format(context))),
                                      DataCell(Text(r.reason)),
                                      DataCell(Text(
                                          r.type == AttendanceType.inScan
                                              ? 'In'
                                              : 'Out')),
                                      const DataCell(Text('0:0')),
                                      const DataCell(Text('0:0')),
                                      DataCell(Text(r.remarks ?? '')),
                                    ]),
                                  )
                                  .toList(),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 16),
                      // Right panel
                      SizedBox(
                        width: 360,
                        child: LayoutBuilder(
                          builder: (context, constraints) => SingleChildScrollView(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                            _buildDetailRow(
                                'Employee Code', employee?.code ?? ''),
                            _buildDetailRow(
                                'Employee Name', employee?.name ?? ''),
                            _buildDetailRow('Designation Name',
                                employee?.designation ?? ''),
                            _buildDetailRow('Branch Name', ''),
                            _buildDetailRow(
                                'Group Name', employee?.department ?? ''),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                Expanded(
                                  child: Center(
                                    child: Text(
                                      _lastType == AttendanceType.outScan
                                          ? 'OUT'
                                          : 'IN',
                                      style: TextStyle(
                                        color:
                                            _lastType == AttendanceType.outScan
                                                ? Colors.red
                                                : Colors.green,
                                        fontSize: 48,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                                ),
                                Container(
                                  width: 130,
                                  height: 130,
                                  color: Colors.grey.shade300,
                                  child: employee?.imageUrl != null
                                      ? Image.network(
                                          employee!.imageUrl!,
                                          fit: BoxFit.cover,
                                        )
                                      : const Icon(Icons.person, size: 64),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            Text(
                              _formatLongDate(_now),
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            Text(
                              TimeOfDay.fromDateTime(_now).format(context),
                              style: Theme.of(context)
                                  .textTheme
                                  .headlineMedium
                                  ?.copyWith(fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(height: 12),
                            Row(
                              children: [
                                ElevatedButton(
                                  onPressed: () => Navigator.maybePop(context),
                                  child: const Text('Close'),
                                ),
                                const SizedBox(width: 8),
                                OutlinedButton(
                                  onPressed: () => setState(() {}),
                                  child: const Text('Refresh'),
                                ),
                              ],
                            ),
                          ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                // Bottom tabs (flex to available space to avoid overflow)
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      TabBar(
                        controller: _tabController,
                        labelColor: Theme.of(context).colorScheme.primary,
                        tabs: const [
                          Tab(text: 'Present Employees (0)'),
                          Tab(text: 'Absent Employees (0)'),
                          Tab(text: 'Out Employees (0)'),
                        ],
                      ),
                      Expanded(
                        child: TabBarView(
                          controller: _tabController,
                          children: const [
                            _EmptyGrid(),
                            _EmptyGrid(),
                            _EmptyGrid(),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (isLoading) const LinearProgressIndicator(),
        ],
      ),
    );
  }
}

class _EmptyGrid extends StatelessWidget {
  const _EmptyGrid();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade400),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(columns: const [
          DataColumn(label: Text('E.Code')),
          DataColumn(label: Text('E.Name')),
          DataColumn(label: Text('Time')),
          DataColumn(label: Text('Reason')),
          DataColumn(label: Text('Remarks')),
          DataColumn(label: Text('Department')),
          DataColumn(label: Text('Section')),
        ], rows: const []),
      ),
    );
  }
}

Widget _buildDetailRow(String label, String value) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: [
        SizedBox(
          width: 140,
          child:
              Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        ),
        Expanded(
          child: Container(
            height: 32,
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

String _formatLongDate(DateTime date) {
  final weekdayNames = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];
  final monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  final wd = weekdayNames[date.weekday - 1];
  final m = monthNames[date.month - 1];
  return '$wd, $m ${date.day}, ${date.year}';
}
