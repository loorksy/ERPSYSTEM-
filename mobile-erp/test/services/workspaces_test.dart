import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lork_erp/data/app_database.dart';
import 'package:lork_erp/data/workspaces.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfiNoIsolate;
  late Directory dir;
  late WorkspaceRegistry registry;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('ws_test');
    registry = await WorkspaceRegistry.open(
      directory: dir.path,
      factory: factory,
    );
  });

  tearDown(() async {
    await registry.close();
    await dir.delete(recursive: true);
  });

  Future<AppDatabase> openDb(Workspace w) =>
      AppDatabase.open(path: registry.pathOf(w), factory: factory);

  test('the main workspace keeps the original database file', () async {
    final list = await registry.list();
    expect(list.length, 1);
    expect(list.first.isMain, isTrue);
    expect(list.first.file, 'lork_erp.db');
    expect((await registry.active()).id, WorkspaceRegistry.mainId);
  });

  test('workspaces keep their data, settings and columns apart', () async {
    final main = (await registry.list()).first;
    final other = await registry.create('  شركة   النور ');
    expect(other.name, 'شركة النور');
    final a = await openDb(main);
    final b = await openDb(other);
    await a.insertCycle(
      name: 'دورة الرئيسية',
      managementRows: const [],
      agentRows: const [],
    );
    await b.saveWorkspaceColumns(
      const WorkspaceColumns(mgmtShareCol: 'X', unmentionedLabel: 'خارج'),
    );
    await b.savePayrollSettings(const PayrollSettings(discountRate: 7));
    expect((await a.listCycles()).length, 1);
    expect((await b.listCycles()).length, 0);
    expect((await a.getWorkspaceColumns()).mgmtShareCol, 'W');
    expect((await b.getWorkspaceColumns()).mgmtShareCol, 'X');
    expect((await b.getWorkspaceColumns()).unmentionedLabel, 'خارج');
    expect((await a.getPayrollSettings()).discountRate, 0);
    expect((await b.getPayrollSettings()).discountRate, 7);
    await a.close();
    await b.close();
  });

  test('switch, rename and delete', () async {
    final other = await registry.create('ثانية');
    await registry.setActive(other.id);
    expect((await registry.active()).id, other.id);

    Object? error;
    try {
      await registry.delete(other.id);
    } catch (e) {
      error = e;
    }
    expect(error, isNotNull);
    try {
      await registry.delete(WorkspaceRegistry.mainId);
    } catch (e) {
      error = e;
    }
    expect('$error', contains('الرئيسية'));

    await registry.rename(other.id, 'الشركة الثانية');
    expect((await registry.get(other.id))!.name, 'الشركة الثانية');

    final db = await openDb(other);
    await db.insertCycle(
      name: 'x',
      managementRows: const [],
      agentRows: const [],
    );
    await db.close();
    final file = File(registry.pathOf(other));
    expect(file.existsSync(), isTrue);

    await registry.setActive(WorkspaceRegistry.mainId);
    await registry.delete(other.id);
    expect((await registry.list()).length, 1);
    expect(file.existsSync(), isFalse);
  });

  test('an unknown active workspace falls back to the first one', () async {
    await registry.setActive(99);
    expect((await registry.active()).id, WorkspaceRegistry.mainId);
  });
}
