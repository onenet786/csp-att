import 'dart:async';
import 'package:employee_attendance/models/attendance_record.dart';
import 'package:employee_attendance/providers/attendance_provider.dart';
import 'package:employee_attendance/screens/employee_details_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
  final FocusNode _hotkeyFocus = FocusNode(debugLabel: 'hotkey_focus');
  final List<AttendanceRecord> _recentMarks = <AttendanceRecord>[];
  Timer? _clockTimer;
  DateTime _now = DateTime.now();
  AttendanceType? _lastType;
  Timer? _searchDebounce;
  String _lastLoadedCode = '';
  String? _selectedReason;

  @override
  void dispose() {
    _tabController.dispose();
    _codeController.dispose();
    _hotkeyFocus.dispose();
    _clockTimer?.cancel();
    _searchDebounce?.cancel();
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
    // Ensure keyboard listener receives focus
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _hotkeyFocus.requestFocus();
      }
    });
  }

  Future<bool> _handleSubmit(
    String code,
    AttendanceType type, {
    String? reason,
  }) async {
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
    final trimmedCode = code.trim();
    if (trimmedCode.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please enter employee code')),
        );
      }
      return false;
    }

    // Reason handling: require for checkout (Out)
    final providedReason = (reason ?? (type == AttendanceType.outScan ? '' : 'Duty')).trim();
    setState(() {
      _selectedReason = providedReason.isEmpty ? null : providedReason;
    });
    if (type == AttendanceType.outScan && providedReason.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Checkout requires reason. Use hotkeys 1..9,0,+,-')),
        );
      }
      return false;
    }
    final record = AttendanceRecord(
      employeeCode: trimmedCode,
      timestamp: DateTime.now(),
      reason: providedReason,
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Attendance marked')),
      );
      return true;
    }

    // If check-in failed for any reason, prompt for checkout reason automatically
    if (type == AttendanceType.inScan) {
      if (!mounted) return false;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(provider.errorMessage == null
            ? 'Check-In failed. Select a reason to check-out'
            : '${provider.errorMessage}. Select a reason to check-out')),
      );
      final picked = await _showReasonPicker();
      if (!mounted) return false;
      if (picked != null && picked.trim().isNotEmpty) {
        final chosen = picked.trim();
        setState(() {
          _selectedReason = chosen;
        });
        // Submit checkout with selected reason
        return _handleSubmit(trimmedCode, AttendanceType.outScan, reason: chosen);
      } else {
        if (!mounted) return false;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Checkout requires reason. Use hotkeys 1..9,0,+,-')),
        );
        return false;
      }
    }

    // Default failure path
    if (!mounted) return false;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(provider.errorMessage ?? 'Failed to mark attendance'),
      ),
    );
    return false;
  }

  Future<void> _loadInfo(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please enter employee code to load info')),
        );
      }
      return;
    }
    final provider = context.read<AttendanceProvider>();
    await provider.loadEmployee(trimmed);
    if (!mounted) return;
    final found = provider.currentEmployee != null;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(found ? 'Employee info loaded' : 'No employee details found')),
    );

    // After loading info, check current status and auto-show reason picker if already IN
    try {
      final api = provider.api;
      final status = await api.fetchStatusByCode(trimmed);
      final isIn = (status['status']?.toString().toUpperCase() == 'IN');
      if (isIn) {
        final picked = await _showReasonPicker();
        if (!mounted) return;
        if (picked != null && picked.trim().isNotEmpty) {
          final reason = picked.trim();
          setState(() {
            _selectedReason = reason;
          });
          await _handleSubmit(trimmed, AttendanceType.outScan, reason: reason);
        } else {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Checkout requires reason. Use hotkeys 1..9,0,+,-')),
          );
        }
      }
    } catch (_) {
      // Ignore status errors; continue normal flow
    }
  }

  void _onCodeChanged(String value) {
    final trimmed = value.trim();
    _searchDebounce?.cancel();
    if (trimmed.isEmpty) return;
    _searchDebounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      if (trimmed == _lastLoadedCode) return;
      _autoLoadInfo(trimmed);
    });
  }

  Future<void> _autoLoadInfo(String code) async {
    final provider = context.read<AttendanceProvider>();
    await provider.loadEmployee(code);
    if (!mounted) return;
    _lastLoadedCode = code;
    setState(() {});
  }

  Future<String?> _showReasonPicker() async {
    const reasons = [
      'Personal',
      'Tea',
      'Official Work',
      'Lunch',
      'Prayer',
      'Duty Off',
      'Other',
      'Short Leave',
      'Smoking',
      'Iftar',
      'Dinner',
      'Rest',
    ];
    return showDialog<String>(
      context: context,
      builder: (ctx) {
        return SimpleDialog(
          title: const Text('Select checkout reason'),
          children: [
            for (final r in reasons)
              SimpleDialogOption(
                onPressed: () => Navigator.of(ctx).pop(r),
                child: Text(r),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text(
                'Tip: You can also use keyboard hotkeys 1..9, 0, +, -',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        );
      },
    );
  }

  String? _reasonFromKey(KeyEvent e) {
    if (e is! KeyDownEvent) return null;
    final ch = e.character;
    const map = {
      '1': 'Personal',
      '2': 'Tea',
      '3': 'Official Work',
      '4': 'Lunch',
      '5': 'Prayer',
      '6': 'Duty Off',
      '7': 'Other',
      '8': 'Short Leave',
      '9': 'Smoking',
      '+': 'Iftar',
      '0': 'Dinner',
      '-': 'Rest',
    };
    if (ch != null && map.containsKey(ch)) {
      return map[ch];
    }
    final key = e.logicalKey;
    if (key == LogicalKeyboardKey.numpadAdd || key == LogicalKeyboardKey.equal) {
      return 'Iftar';
    }
    if (key == LogicalKeyboardKey.numpadSubtract || key == LogicalKeyboardKey.minus) {
      return 'Rest';
    }
    return null;
  }

  void _onKeyEvent(KeyEvent e) {
    final reason = _reasonFromKey(e);
    if (reason != null) {
      final code = _codeController.text.trim();
      if (code.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Enter employee code before checkout')),
        );
        return;
      }
      setState(() {
        _selectedReason = reason;
      });
      _handleSubmit(code, AttendanceType.outScan, reason: reason);
    }
  }


  

  @override
  Widget build(BuildContext context) {
    final isLoading = context.watch<AttendanceProvider>().isSubmitting;
    final employee = context.watch<AttendanceProvider>().currentEmployee;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Terminal Attendance'),
        actions: [
          IconButton(
            tooltip: 'Employee Details',
            icon: const Icon(Icons.info_outline),
            onPressed: () {
              final code = _codeController.text.trim();
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => EmployeeDetailsScreen(
                    initialCode: code.isEmpty ? null : code,
                  ),
                ),
              );
            },
          ),
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
      body: KeyboardListener(
        focusNode: _hotkeyFocus,
        autofocus: true,
        onKeyEvent: _onKeyEvent,
        child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _codeController,
                              decoration: const InputDecoration(
                                labelText: 'Enter Employee Code',
                                border: OutlineInputBorder(),
                              ),
                              onChanged: _onCodeChanged,
                              onSubmitted: (_) => _loadInfo(
                                _codeController.text.trim(),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton(
                            onPressed: () => _loadInfo(_codeController.text.trim()),
                            child: const Text('Load Info'),
                          ),
                          const SizedBox(width: 8),
                          ElevatedButton(
                            onPressed: () => _handleSubmit(
                              _codeController.text.trim(),
                              AttendanceType.inScan,
                            ),
                            child: const Text('Check-In'),
                          ),
                          const SizedBox(width: 8),
                          ElevatedButton(
                            onPressed: () async {
                              final code = _codeController.text.trim();
                              if (code.isEmpty) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(content: Text('Enter employee code before checkout')),
                                );
                                return;
                              }
                              final reason = await _showReasonPicker();
                              if (reason == null || reason.trim().isEmpty) return;
                              setState(() {
                                _selectedReason = reason.trim();
                              });
                              await _handleSubmit(code, AttendanceType.outScan, reason: reason.trim());
                            },
                            child: const Text('Check-Out'),
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
                            scrollDirection: Axis.horizontal,
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
                      ),
                      const SizedBox(width: 16),
                      // Right panel
                      Flexible(
                        flex: 1,
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 380),
                          child: SingleChildScrollView(
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
                            _buildDetailRow(
                                'Today Check-In',
                                _formatMaybeTime(context, context.watch<AttendanceProvider>().todayCheckInTime)),
                            _buildDetailRow(
                                'Today Check-Out',
                                _formatMaybeTime(context, context.watch<AttendanceProvider>().todayCheckOutTime)),
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
                                          errorBuilder: (context, error, stack) => const Icon(Icons.person, size: 64),
                                        )
                                      : const Icon(Icons.person, size: 64),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            _buildDetailRow('Selected Reason', _selectedReason ?? ''),
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
                        isScrollable: true,
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

String _formatMaybeTime(BuildContext context, DateTime? dt) {
  if (dt == null) return 'Not recorded';
  try {
    return TimeOfDay.fromDateTime(dt).format(context);
  } catch (_) {
    return dt.toLocal().toIso8601String();
  }
}
