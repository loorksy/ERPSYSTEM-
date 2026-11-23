import 'dart:ui';

import 'package:workmanager/workmanager.dart';

import '../data/app_database.dart';
import '../data/workspaces.dart';
import '../google/google_auth.dart';
import '../google/sheets_client.dart';
import '../services/audit_job_runner.dart';
import '../services/cycle_service.dart';
import '../services/payroll_service.dart';

const auditWorkName = 'lork-audit-jobs';

/// Entry point of the Android background worker (WorkManager). It runs the
/// saved audit jobs even when the app is closed, and only while the phone
/// has internet (network constraint). Returning false asks WorkManager to
/// run it again later.
@pragma('vm:entry-point')
void auditCallbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    DartPluginRegistrant.ensureInitialized();
    final registry = await WorkspaceRegistry.open();
    final auth = GoogleAuth();
    await auth.restore();
    final sheets = GoogleSheetsApi(auth);
    // Every workspace (one database each) may have an unfinished job.
    var finished = true;
    for (final w in await registry.list()) {
      // The databases stay open: the app shares the same native connection.
      final db = await AppDatabase.open(path: registry.pathOf(w));
      if ((await db.pendingAuditJobs()).isEmpty) continue;
      final runner = AuditJobRunner(
        db,
        PayrollService(db, () => sheets),
        CycleService(db, () => sheets),
        owner: 'worker',
      );
      if (!await runner.runPending()) finished = false;
    }
    return finished;
  });
}

Future<void> initAuditWorker() async {
  try {
    await Workmanager().initialize(auditCallbackDispatcher);
  } catch (_) {
    // Not available on this platform (desktop preview).
  }
}

/// Schedules the worker if it is not already scheduled or running.
/// [now] replaces a worker that is waiting for its retry delay.
Future<bool> enqueueAuditWorker({bool now = false}) async {
  try {
    await Workmanager().registerOneOffTask(
      auditWorkName,
      auditWorkName,
      constraints: Constraints(networkType: NetworkType.connected),
      existingWorkPolicy:
          now ? ExistingWorkPolicy.replace : ExistingWorkPolicy.keep,
      backoffPolicy: BackoffPolicy.linear,
      backoffPolicyDelay: const Duration(seconds: 30),
      foregroundServiceConfig: ForegroundServiceConfig(
        notificationTitle: 'LorkERP',
        notificationText: 'جاري تنفيذ التدقيق على Google Sheets…',
        notificationChannelId: 'lork_audit_jobs',
        notificationChannelName: 'التدقيق',
        notificationId: 7101,
        foregroundServiceType: ForegroundServiceType.dataSync,
      ),
    );
    return true;
  } catch (_) {
    return false;
  }
}
