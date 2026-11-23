import 'dart:convert';

import '../data/app_database.dart';
import '../google/google_auth.dart';
import '../google/sheets_client.dart';
import 'adjustments_service.dart';
import 'cycle_service.dart';
import 'payroll_service.dart';

class _Transient implements Exception {
  const _Transient(this.message);
  final String message;
}

/// Runs Google audits as resumable jobs (owner's request, 2026-11-17).
/// The «غير مذكور» tools ([JobKind]) run the same way.
///
/// A job follows ERP `payrollRunAudit`: 1/2 sync the cycle and the
/// user-info sheet, 2/2 `payroll-execute`. The writes are saved as a plan
/// of steps in SQLite and each finished step is recorded, so a lost
/// connection, a closed app or a killed process only pauses the audit: the
/// next run continues from the first unfinished step (copying, salary and
/// status, colouring) until it is done in Google Sheets too.
class AuditJobRunner {
  AuditJobRunner(
    this.db,
    this.payroll,
    this.cycles, {
    AdjustmentsService? adjustments,
    this.owner = 'app',
    this.retryDelays = const [
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
      Duration(seconds: 60),
    ],
  }) : adjustments =
           adjustments ?? AdjustmentsService(db, payroll.sheetsProvider);

  final AppDatabase db;

  /// «إضافات وخصومات» jobs (no cycle).
  final AdjustmentsService adjustments;
  final PayrollService payroll;
  final CycleService cycles;

  /// Waits between in-run retries after a lost connection. When they are
  /// used up the job is left «waiting» and the caller schedules another run.
  final List<Duration> retryDelays;

  /// 'app' while the app is open, 'worker' in the Android background worker.
  /// A lease in the database lets only one of them run a job at a time.
  final String owner;
  static const lease = Duration(seconds: 90);

  bool _busy = false;

  /// Runs every unfinished job. Returns false when a job is still waiting
  /// for the internet or for Google, so the caller should run again later.
  Future<bool> runPending() async {
    if (_busy) return true;
    _busy = true;
    try {
      for (;;) {
        final pending = await db.pendingAuditJobs();
        if (pending.isEmpty) return true;
        final job = pending.first;
        if (!await db.claimAuditJob(job.id, owner, lease)) {
          // The other runner has it; the worker checks again later.
          return owner == 'app';
        }
        final ended = await runJob(job);
        await db.releaseAuditJob(job.id);
        if (!ended) return false;
      }
    } finally {
      _busy = false;
    }
  }

  /// Returns true when the job ended (done or failed), false when it has to
  /// wait and be retried later.
  Future<bool> runJob(AuditJob job) async {
    if (JobKind.of(job.request) == JobKind.adjustments) {
      return _runAdjustments(job);
    }
    final request = PayrollRequest.fromJson(job.request);
    final kind = JobKind.of(job.request);
    final options = UnmentionedOptions.fromJson(job.request['unmentioned']);
    AuditPlan? plan;
    final saved = await db.getAuditJobPlan(job.id);
    if (saved != null) {
      plan = AuditPlan.fromJson(saved)..next = job.stepNext;
    }
    Future<void> progress(String m) async {
      await db.updateAuditJob(job.id, {'progress': m});
      await db.claimAuditJob(job.id, owner, lease);
    }

    await db.updateAuditJob(job.id, {
      'status': AuditJob.running,
      'attempts': job.attempts + 1,
      'error': null,
    });
    var failures = 0;
    for (;;) {
      try {
        if (plan == null) {
          await progress('1/2 مزامنة...');
          final ui = request.userInfo as GoogleUserInfo;
          // ERP payrollSyncForAudit: the audit stops if this sync fails.
          final sync = await cycles.syncCycle(
            request.cycleId,
            userInfoSpreadsheetId: ui.spreadsheetId,
            userInfoSheetName: ui.sheetName,
          );
          if (!sync.success) {
            if (sync.transient) throw _Transient(sync.message);
            return await _fail(job.id, PayrollResult.fail(sync.message));
          }
          await progress(
            sync.detail == null
                ? sync.message
                : '${sync.message} — ${sync.detail}',
          );
          final prepared = switch (kind) {
            JobKind.unmentionedUsers => await payroll.prepareUnmentionedUsers(
              request,
              options,
              progress,
            ),
            JobKind.unmentionedMgmt => await payroll.prepareUnmentionedMgmt(
              request,
              options,
              progress,
            ),
            _ => await payroll.prepareGoogle(request, progress),
          };
          final p = prepared.plan;
          if (p == null) return await _fail(job.id, prepared.failure!);
          plan = p;
          await db.updateAuditJob(job.id, {
            'plan_json': jsonEncode(p.toJson()),
            'step_next': 0,
            'step_total': p.steps.length,
            // Shown while the audit runs (e.g. the duplicated ids).
            'result_json': jsonEncode(p.result.toJson()),
          });
        }
        final current = plan;
        while (!current.complete) {
          await payroll.runStep(current, current.next, progress);
          current.next++;
          await db.updateAuditJob(job.id, {'step_next': current.next});
          await db.claimAuditJob(job.id, owner, lease);
        }
        await db.updateAuditJob(job.id, {
          'status': AuditJob.done,
          'result_json': jsonEncode(current.result.toJson()),
          'progress': current.result.message,
          'error': null,
        });
        return true;
      } on GoogleNotConnected catch (e) {
        await _wait(job.id, e.toString());
        return false;
      } catch (e) {
        final transient =
            e is _Transient || (e is SheetsApiException && e.transient);
        if (!transient) {
          return _fail(job.id, PayrollResult.fail(_message(e)));
        }
        if (failures >= retryDelays.length) {
          await _wait(
            job.id,
            'انقطع الاتصال بـ Google. سيُستأنف التدقيق تلقائيًا من حيث توقف عند عودة الإنترنت.',
          );
          return false;
        }
        final delay = retryDelays[failures++];
        await db.updateAuditJob(job.id, {
          'status': AuditJob.waiting,
          'error': _message(e),
          'progress':
              'انقطع الاتصال — إعادة المحاولة خلال ${delay.inSeconds} ثانية (${plan == null ? 'المزامنة' : 'الخطوة ${plan.next + 1} من ${plan.steps.length}'})',
        });
        await db.claimAuditJob(job.id, owner, delay + lease);
        await Future<void>.delayed(delay);
        await db.updateAuditJob(job.id, {'status': AuditJob.running});
      }
    }
  }

  /// «إضافات وخصومات»: read and compute once, then write in batches; a
  /// lost connection waits and resumes at the same batch.
  Future<bool> _runAdjustments(AuditJob job) async {
    final request = AdjustRequest.fromJson(job.request);
    AdjustPlan? plan;
    final saved = await db.getAuditJobPlan(job.id);
    if (saved != null) plan = AdjustPlan.fromJson(saved)..next = job.stepNext;
    Future<void> progress(String m) async {
      await db.updateAuditJob(job.id, {'progress': m});
      await db.claimAuditJob(job.id, owner, lease);
    }

    await db.updateAuditJob(job.id, {
      'status': AuditJob.running,
      'attempts': job.attempts + 1,
      'error': null,
    });
    var failures = 0;
    for (;;) {
      try {
        if (plan == null) {
          final p = await adjustments.prepare(request, progress);
          if (p.failure != null) {
            await db.updateAuditJob(job.id, {
              'status': AuditJob.failed,
              'error': p.failure,
              'progress': p.failure,
              'result_json': jsonEncode(p.result.toJson()),
            });
            return true;
          }
          plan = p;
          await db.updateAuditJob(job.id, {
            'plan_json': jsonEncode(p.toJson()),
            'step_next': 0,
            'step_total': p.steps.length,
          });
        }
        final current = plan;
        while (!current.complete) {
          await adjustments.runStep(current, current.next, progress);
          current.next++;
          await db.updateAuditJob(job.id, {'step_next': current.next});
          await db.claimAuditJob(job.id, owner, lease);
        }
        await db.updateAuditJob(job.id, {
          'status': AuditJob.done,
          'result_json': jsonEncode(current.result.toJson()),
          'progress': current.result.message,
          'error': null,
        });
        return true;
      } on GoogleNotConnected catch (e) {
        await _wait(job.id, e.toString());
        return false;
      } catch (e) {
        final transient = e is SheetsApiException && e.transient;
        if (!transient) {
          final m = _message(e);
          await db.updateAuditJob(job.id, {
            'status': AuditJob.failed,
            'error': m,
            'progress': m,
            'result_json': jsonEncode(
              AdjustOutcome(success: false, message: m).toJson(),
            ),
          });
          return true;
        }
        if (failures >= retryDelays.length) {
          await _wait(
            job.id,
            'انقطع الاتصال بـ Google. ستُستأنف المعالجة تلقائيًا من حيث توقفت عند عودة الإنترنت.',
          );
          return false;
        }
        final delay = retryDelays[failures++];
        await db.updateAuditJob(job.id, {
          'status': AuditJob.waiting,
          'error': _message(e),
          'progress':
              'انقطع الاتصال — إعادة المحاولة خلال ${delay.inSeconds} ثانية',
        });
        await db.claimAuditJob(job.id, owner, delay + lease);
        await Future<void>.delayed(delay);
        await db.updateAuditJob(job.id, {'status': AuditJob.running});
      }
    }
  }

  static String _message(Object e) {
    if (e is _Transient) return e.message;
    final m = e.toString();
    return m.startsWith('Exception: ') ? m.substring(11) : m;
  }

  Future<void> _wait(int id, String message) => db.updateAuditJob(id, {
    'status': AuditJob.waiting,
    'error': message,
    'progress': message,
  });

  Future<bool> _fail(int id, PayrollResult failure) async {
    await db.updateAuditJob(id, {
      'status': AuditJob.failed,
      'error': failure.message,
      'progress': failure.message,
      'result_json': jsonEncode(failure.toJson()),
    });
    return true;
  }
}
