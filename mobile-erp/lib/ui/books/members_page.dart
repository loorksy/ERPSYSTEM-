// Flutter 3.50 deprecates its bundled Material exports; keep the SDK widgets.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../accounting/money.dart';
import '../../accounting/parties.dart';
import '../../accounting/trading.dart';
import '../../services/search_service.dart';
import '../erp_theme.dart';
import '../erp_widgets.dart';
import '../help.dart';
import '../ui_kit.dart';
import 'books_kit.dart';
import 'parties_pages.dart';

const membersHelp = [
  HelpItem(
    '',
    'دليل الأعضاء: كل رقم مستخدم ظهر في جداول الدورات المحفوظة على الهاتف (الإدارة والوكيل)، مع الاسم وعدد الدورات وراتب آخر دورة من جدول الوكيل قبل الخصم.',
  ),
  HelpItem(
    '',
    'لكل عضو حساب اختياري في «ذمم الأعضاء» لديونه ومكافآته ومشترياته من الشحن؛ يُنشأ من ملف العضو.',
  ),
  HelpItem(
    '',
    'الدليل يُقرأ من نسخ الدورات المحفوظة: زامن الدورة أو دقّقها ليظهر أعضاؤها.',
  ),
];

class MembersPage extends StatefulWidget {
  const MembersPage({super.key});
  @override
  State<MembersPage> createState() => _MembersPageState();
}

class _MembersPageState extends State<MembersPage> {
  String _q = '';
  int _limit = 100;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: 'دليل الأعضاء',
    help: membersHelp,
    load: (s) async {
      final members = await s.search.members();
      final accounts = await s.parties.list(PartyKind.member);
      return (
        members: members,
        accounts: {
          for (final p in accounts)
            if (p.code.isNotEmpty) p.code: p,
        },
      );
    },
    build: (context, data, reload) {
      final d =
          data as ({List<MemberSummary> members, Map<String, Party> accounts});
      final q = _q.trim();
      final shown = [
        for (final m in d.members)
          if (q.isEmpty || m.id.contains(q) || m.name.contains(q)) m,
      ];
      final debt = d.accounts.values.fold(0, (n, p) => n + p.toUs);
      return [
        FigsRow(
          figs: [
            ('${d.members.length}', 'عضو', null),
            ('${d.accounts.length}', 'له حساب', null),
            (formatCentsShort(debt), 'ديون الأعضاء لنا', Tw.accentInk),
          ],
        ),
        gap,
        SheetSearch(
          hint: 'ابحث برقم المستخدم أو الاسم',
          onChanged:
              (v) => setState(() {
                _q = v;
                _limit = 100;
              }),
        ),
        gap,
        if (shown.isEmpty)
          EmptyState(
            icon: Icons.badge_outlined,
            title: d.members.isEmpty ? 'لا أعضاء بعد' : 'لا نتائج',
            message:
                d.members.isEmpty
                    ? 'يُملأ الدليل من الدورات المالية بعد مزامنتها أو تدقيقها.'
                    : 'جرّب رقمًا أو اسمًا آخر.',
          )
        else ...[
          GroupList(
            children: [
              for (final m in shown.take(_limit))
                ListRow(
                  title: m.name.isEmpty ? m.id : m.name,
                  leading: IconChip(
                    Icons.person_outline,
                    color: Tw.accentInk,
                    bg: Tw.accentSoft,
                  ),
                  subtitle: Text(
                    '${m.id} · ${m.cycles} دورة · ${m.lastCycle}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      d.accounts[m.id] == null
                          ? Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Money(
                                centsOf(m.lastSalary),
                                size: 13.5,
                                color: Tw.ink2,
                              ),
                              Text(
                                'آخر راتب',
                                style: Ds.secondary.copyWith(fontSize: 12),
                              ),
                            ],
                          )
                          : PartyBalance(d.accounts[m.id]!.balance, size: 13.5),
                      const RowChevron(),
                    ],
                  ),
                  onTap: () => openPage(context, MemberPage(member: m)),
                ),
            ],
          ),
          if (shown.length > _limit) ...[
            gap,
            ErpButton(
              label: 'عرض المزيد (${shown.length - _limit})',
              kind: ErpButtonKind.soft,
              onPressed: () => setState(() => _limit += 200),
            ),
          ],
        ],
      ];
    },
  );
}

class MemberPage extends StatelessWidget {
  const MemberPage({super.key, required this.member});
  final MemberSummary member;

  @override
  Widget build(BuildContext context) => BooksPage(
    title: member.name.isEmpty ? member.id : member.name,
    help: membersHelp,
    load: (s) async {
      final hits = await s.search.searchAcrossCycles(member.id, 0);
      final account =
          (await s.parties.list(
            PartyKind.member,
          )).where((p) => p.code == member.id).firstOrNull;
      final moves =
          account == null
              ? <StockMove>[]
              : await s.trading.moves(partyAccountId: account.account.id);
      return (hits: hits.hits, account: account, moves: moves);
    },
    build: (context, data, reload) {
      final d =
          data
              as ({
                List<CycleSearchHit> hits,
                Party? account,
                List<StockMove> moves,
              });
      final p = d.account;
      return [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: panelDecoration(radius: Ds.radiusL),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('رقم المستخدم ${member.id}', style: Ds.secondary),
              const SizedBox(height: 4),
              Text(
                '${member.cycles} دورة · آخرها ${member.lastCycle}',
                style: Ds.body,
              ),
              const SizedBox(height: 12),
              if (p == null)
                ErpButton(
                  label: 'إنشاء حساب للعضو',
                  icon: Icons.person_add_alt,
                  kind: ErpButtonKind.indigoSoft,
                  height: 42,
                  onPressed:
                      () => runPosting(
                        context,
                        (s) => s.parties.add(
                          PartyKind.member,
                          member.name.isEmpty
                              ? 'عضو ${member.id}'
                              : '${member.name} (${member.id})',
                          code: member.id,
                        ),
                        done: 'أُنشئ الحساب',
                      ),
                )
              else
                Row(
                  children: [
                    Expanded(child: Text('حساب العضو', style: Ds.body)),
                    PartyBalance(p.balance, size: 18),
                  ],
                ),
            ],
          ),
        ),
        if (p != null) ...[
          gap,
          GroupList(
            children: [
              HubRow(
                icon: Icons.account_circle_outlined,
                title: 'ملف حساب العضو',
                subtitle: 'دين، مكافأة، قبض، دفع، كشف',
                onTap:
                    () => openPage(context, PartyPage(accountId: p.account.id)),
              ),
            ],
          ),
        ],
        gap,
        SectionLabel('سجل الدورات', trailing: Text('${d.hits.length}')),
        if (d.hits.isEmpty)
          const Caption('لم يُعثر عليه في الدورات المحفوظة.')
        else
          GroupList(
            children: [
              for (final h in d.hits)
                ListRow(
                  title: h.cycleName,
                  leading: IconChip(Icons.calendar_today_outlined),
                  subtitle: Text(
                    '${h.logicalStatus} · ${h.auditStatus.isEmpty ? 'غير مدقق' : h.auditStatus}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: Money(centsOf(h.salaryBefore), size: 14),
                ),
            ],
          ),
        if (d.moves.isNotEmpty) ...[
          gap,
          const SectionLabel('الشحن'),
          GroupList(
            children: [
              for (final m in d.moves)
                ListRow(
                  title:
                      '${m.isSale ? 'شراء' : 'بيع'} ${formatQty(m.qty.abs())} ${m.itemName}',
                  subtitle: Text(dateLabel(m.entry.date)),
                  trailing: Money(m.amount),
                  onTap: () => showEntrySheet(context, m.entry.id),
                ),
            ],
          ),
        ],
      ];
    },
  );
}
