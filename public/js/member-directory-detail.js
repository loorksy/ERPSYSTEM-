(function () {
  const root = document.getElementById('mdDetailRoot');
  if (!root) return;
  const memberUserId = root.getAttribute('data-member-id') || '';
  const summary = document.getElementById('mdDetailSummary');
  const titleEl = document.getElementById('mdDetailMemberId');
  const deferredBlock = document.getElementById('mdDeferredBlock');
  const auditBlock = document.getElementById('mdAuditBlock');
  const eventsBlock = document.getElementById('mdEventsBlock');
  const adjBlock = document.getElementById('mdAdjBlock');
  const shippingBlock = document.getElementById('mdShippingBlock');

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function load() {
    const url = '/api/member-directory/member/' + encodeURIComponent(memberUserId);
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) {
      summary.innerHTML = '<p class="text-red-600">' + esc(data.message || 'فشل') + '</p>';
      return;
    }
    const p = data.profile;
    titleEl.textContent = p ? p.member_user_id : memberUserId;
    if (p) {
      summary.innerHTML =
        '<div class="rounded-xl border border-slate-100 bg-slate-50/80 p-3"><div class="text-xs text-slate-500">الاسم</div><div class="font-medium">' +
        esc(p.display_name || p.last_seen_name || '—') +
        '</div></div>' +
        '<div class="rounded-xl border border-slate-100 bg-slate-50/80 p-3"><div class="text-xs text-slate-500">آخر راتب (تدقيق)</div><div class="font-mono">' +
        esc(Number(p.total_salary_audited_usd || 0).toFixed(2)) +
        ' USD</div><div class="text-[0.65rem] text-slate-400 mt-1">يُحدَّد من آخر تدقيق يتضمّن مبلغ الراتب</div></div>' +
        '<div class="rounded-xl border border-slate-100 bg-slate-50/80 p-3"><div class="text-xs text-slate-500">رصيد مؤجل</div><div class="font-mono">' +
        esc(Number(p.deferred_balance_usd || 0).toFixed(2)) +
        ' USD</div></div>' +
        '<div class="rounded-xl border border-slate-100 bg-slate-50/80 p-3"><div class="text-xs text-slate-500">دين على العضو</div><div class="font-mono">' +
        esc(Number(p.debt_to_company_usd || 0).toFixed(2)) +
        ' USD</div></div>';
    } else {
      summary.innerHTML =
        '<p class="text-slate-600 col-span-full">لا يوجد ملف بعد — سيُنشأ عند أول تدقيق أو تعديل.</p>';
    }

    const dh = data.deferredHistory || [];
    deferredBlock.innerHTML = dh.length
      ? '<ul class="list-disc list-inside space-y-1">' +
        dh
          .map(
            (r) =>
              '<li>دورة ' +
              esc(r.cycle_id) +
              ' — ' +
              esc(Number(r.balance_d || 0).toFixed(2)) +
              ' — ' +
              esc(r.cycle_name || '') +
              '</li>'
          )
          .join('') +
        '</ul>'
      : '<p class="text-slate-500">لا سجلات مؤجل.</p>';

    const ar = data.auditRows || [];
    auditBlock.innerHTML = ar.length
      ? '<table class="min-w-full text-xs"><thead><tr class="text-slate-500"><th class="py-1 px-2">الدورة</th><th class="py-1 px-2">راتب بعد الخصم</th><th class="py-1 px-2">قبل الخصم</th><th class="py-1 px-2">الحالة</th><th class="py-1 px-2">المصدر</th><th class="py-1 px-2">تاريخ</th></tr></thead><tbody>' +
        ar
          .map((r) => {
            const sal =
              r.salary_audited_usd != null && !Number.isNaN(Number(r.salary_audited_usd))
                ? Number(r.salary_audited_usd).toFixed(2)
                : '—';
            const before =
              r.salary_before_usd != null && !Number.isNaN(Number(r.salary_before_usd))
                ? Number(r.salary_before_usd).toFixed(2)
                : '—';
            const cname = r.cycle_name ? esc(r.cycle_name) + ' — ' : '';
            return (
              '<tr><td class="py-1 px-2 whitespace-nowrap">' +
              cname +
              '#' +
              esc(r.cycle_id) +
              '</td><td class="py-1 px-2 font-mono">' +
              esc(sal) +
              '</td><td class="py-1 px-2 font-mono">' +
              esc(before) +
              '</td><td class="py-1 px-2">' +
              esc(r.audit_status) +
              '</td><td class="py-1 px-2">' +
              esc(r.audit_source || '') +
              '</td><td class="py-1 px-2 whitespace-nowrap">' +
              esc(r.updated_at ? new Date(r.updated_at).toLocaleString('ar') : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table>'
      : '<p class="text-slate-500">لا سجلات تدقيق لهذا الرقم — تأكد من التدقيق من الرواتب أو البحث.</p>';

    const ev = data.events || [];
    eventsBlock.innerHTML = ev.length
      ? ev
          .map(
            (e) =>
              '<div class="border border-slate-100 rounded-lg p-2"><span class="font-semibold">' +
              esc(e.event_type) +
              '</span> — ' +
              esc(e.notes || '') +
              ' <span class="text-slate-400 text-xs">' +
              esc(e.created_at ? new Date(e.created_at).toLocaleString('ar') : '') +
              '</span></div>'
          )
          .join('')
      : '<p class="text-slate-500">لا أحداث.</p>';

    const adj = data.adjustments || [];
    adjBlock.innerHTML = adj.length
      ? adj
          .map(
            (a) =>
              '<div class="border border-slate-100 rounded-lg p-2"><span class="font-semibold">' +
              esc(a.kind) +
              '</span> ' +
              esc(Number(a.amount || 0).toFixed(2)) +
              ' — ' +
              esc(a.status || '') +
              ' — ' +
              esc(a.notes || '') +
              '</div>'
          )
          .join('')
      : '<p class="text-slate-500">لا تعديلات بعد.</p>';

    const ship = data.shippingTransactions || [];
    if (shippingBlock) {
      shippingBlock.innerHTML = ship.length
        ? '<table class="min-w-full text-xs"><thead><tr class="text-slate-500"><th class="py-1 px-2">#</th><th class="py-1 px-2">الصنف</th><th class="py-1 px-2">الكمية</th><th class="py-1 px-2">الإجمالي</th><th class="py-1 px-2">الربح</th><th class="py-1 px-2">الحالة</th></tr></thead><tbody>' +
          ship
            .map(
              (s) =>
                '<tr><td class="py-1 px-2 font-mono">' +
                esc(s.id) +
                '</td><td class="py-1 px-2">' +
                esc(s.item_type) +
                '</td><td class="py-1 px-2 font-mono">' +
                esc(s.quantity) +
                '</td><td class="py-1 px-2 font-mono">' +
                esc(Number(s.total || 0).toFixed(2)) +
                '</td><td class="py-1 px-2 font-mono text-emerald-700">' +
                esc(s.profit_amount != null ? Number(s.profit_amount).toFixed(2) : '—') +
                '</td><td class="py-1 px-2">' +
                esc(s.status || '') +
                '</td></tr>'
            )
            .join('') +
          '</tbody></table>'
        : '<p class="text-slate-500">لا مبيعات شحن مسجّلة لهذا الرقم كمستخدم.</p>';
    }
  }

  load();
})();
