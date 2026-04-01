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

  function moneyTone(n, kind) {
    const v = Number(n);
    if (isNaN(v)) return 'text-slate-800';
    if (kind === 'debt') return v > 0 ? 'text-red-600' : 'text-slate-600';
    if (v < 0) return 'text-red-600';
    if (v > 0) return 'text-sky-700';
    return 'text-slate-600';
  }

  function profitTone(n) {
    const v = Number(n);
    if (isNaN(v)) return 'text-slate-800';
    if (v < 0) return 'text-red-600';
    if (v > 0) return 'text-emerald-700';
    return 'text-slate-600';
  }

  function summaryCard(label, valueHtml, hint, accent) {
    var border =
      accent === 'name'
        ? 'border-l-indigo-500'
        : accent === 'salary'
          ? 'border-l-amber-400'
          : accent === 'deferred'
            ? 'border-l-sky-500'
            : accent === 'debt'
              ? 'border-l-rose-500'
              : 'border-l-slate-300';
    return (
      '<div class="min-w-0 border-l-4 ' +
      border +
      ' bg-transparent py-3 pl-4 sm:py-4">' +
      '<div class="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">' +
      esc(label) +
      '</div>' +
      '<div class="mt-1.5 font-mono text-base font-bold tabular-nums leading-tight sm:text-lg">' +
      valueHtml +
      '</div>' +
      (hint
        ? '<div class="mt-1.5 text-[0.65rem] leading-snug text-slate-400">' + esc(hint) + '</div>'
        : '') +
      '</div>'
    );
  }

  function wireMdNav() {
    const prev = document.getElementById('mdNavPrev');
    const next = document.getElementById('mdNavNext');
    if (!prev || !next) return;
    let ids = [];
    try {
      ids = JSON.parse(sessionStorage.getItem('mdMemberNavIds') || '[]');
    } catch (_) {
      ids = [];
    }
    if (!Array.isArray(ids)) ids = [];
    const cur = String(memberUserId);
    const idx = ids.indexOf(cur);
    if (idx < 0) {
      prev.disabled = true;
      next.disabled = true;
      prev.onclick = null;
      next.onclick = null;
      return;
    }
    prev.disabled = idx <= 0;
    next.disabled = idx >= ids.length - 1;
    prev.onclick = function () {
      if (idx > 0) window.location.href = '/member-directory/member/' + encodeURIComponent(ids[idx - 1]);
    };
    next.onclick = function () {
      if (idx < ids.length - 1) window.location.href = '/member-directory/member/' + encodeURIComponent(ids[idx + 1]);
    };
  }

  async function load() {
    const url = '/api/member-directory/member/' + encodeURIComponent(memberUserId);
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) {
      summary.innerHTML =
        '<div class="border-b border-red-200 bg-red-50 px-4 py-4 text-sm font-medium leading-relaxed text-red-800" role="alert">' +
        esc(data.message || 'فشل التحميل') +
        '</div>';
      wireMdNav();
      return;
    }
    const p = data.profile;
    titleEl.textContent = p ? p.member_user_id : memberUserId;
    if (p) {
      const def = Number(p.deferred_balance_usd || 0);
      const debt = Number(p.debt_to_company_usd || 0);
      summary.innerHTML =
        '<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">' +
        summaryCard('الاسم', '<span class="font-sans text-base font-semibold text-slate-900 sm:text-lg">' + esc(p.display_name || p.last_seen_name || '—') + '</span>', '', 'name') +
        summaryCard(
          'آخر راتب (تدقيق)',
          '<span class="' + moneyTone(p.total_salary_audited_usd, 'balance') + '">' +
            esc(Number(p.total_salary_audited_usd || 0).toFixed(2)) +
            ' USD</span>',
          'من آخر تدقيق يتضمّن مبلغ الراتب',
          'salary'
        ) +
        summaryCard(
          'رصيد مؤجل',
          '<span class="' + moneyTone(def, 'balance') + '">' + esc(def.toFixed(2)) + ' USD</span>',
          '',
          'deferred'
        ) +
        summaryCard(
          'دين على العضو',
          '<span class="' + moneyTone(debt, 'debt') + '">' + esc(debt.toFixed(2)) + ' USD</span>',
          '',
          'debt'
        ) +
        '</div>';
    } else {
      summary.innerHTML =
        '<div class="border-b border-dashed border-slate-200 py-10 text-center text-sm leading-relaxed text-slate-600">لا يوجد ملف بعد — سيُنشأ عند أول تدقيق أو تعديل.</div>';
    }

    const dh = data.deferredHistory || [];
    deferredBlock.innerHTML = dh.length
      ? '<ul class="divide-y divide-slate-200">' +
        dh
          .map((r) => {
            const bal = Number(r.balance_d || 0);
            const tone = bal < 0 ? 'text-red-600' : 'text-sky-700';
            return (
              '<li class="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between">' +
              '<span class="text-sm text-slate-700"><span class="font-semibold text-slate-900">دورة ' +
              esc(r.cycle_id) +
              '</span>' +
              (r.cycle_name ? ' · ' + esc(r.cycle_name) : '') +
              '</span>' +
              '<span class="inline-flex min-w-[6.5rem] items-center justify-center rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 font-mono text-sm font-bold tabular-nums ' +
              tone +
              '" dir="ltr">' +
              esc(bal.toFixed(2)) +
              ' USD</span></li>'
            );
          })
          .join('') +
        '</ul>'
      : '<p class="border-b border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">لا سجلات مؤجل.</p>';

    const ar = data.auditRows || [];
    auditBlock.innerHTML = ar.length
      ? '<div class="overflow-x-auto [-webkit-overflow-scrolling:touch]">' +
        '<table class="min-w-[640px] w-full border-collapse text-right text-sm">' +
        '<thead><tr class="border-b-2 border-slate-200/90 text-[11px] font-bold uppercase tracking-wide text-slate-500">' +
        '<th class="whitespace-nowrap px-2 py-2.5 sm:px-3">الدورة</th>' +
        '<th class="whitespace-nowrap px-2 py-2.5 sm:px-3">راتب بعد الخصم</th>' +
        '<th class="whitespace-nowrap px-2 py-2.5 sm:px-3">قبل الخصم</th>' +
        '<th class="px-2 py-2.5 sm:px-3">الحالة</th>' +
        '<th class="px-2 py-2.5 sm:px-3">المصدر</th>' +
        '<th class="whitespace-nowrap px-2 py-2.5 sm:px-3">تاريخ</th>' +
        '</tr></thead><tbody class="divide-y divide-slate-100">' +
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
              '<tr class="transition-colors hover:bg-indigo-50/40">' +
              '<td class="whitespace-nowrap px-2 py-2.5 text-slate-800 sm:px-3">' +
              cname +
              '#' +
              esc(r.cycle_id) +
              '</td>' +
              '<td class="px-2 py-2.5 font-mono tabular-nums text-slate-900 sm:px-3" dir="ltr">' +
              esc(sal) +
              '</td>' +
              '<td class="px-2 py-2.5 font-mono tabular-nums text-slate-600 sm:px-3" dir="ltr">' +
              esc(before) +
              '</td>' +
              '<td class="px-2 py-2.5 sm:px-3">' +
              esc(r.audit_status) +
              '</td>' +
              '<td class="px-2 py-2.5 text-slate-600 sm:px-3">' +
              esc(r.audit_source || '') +
              '</td>' +
              '<td class="whitespace-nowrap px-2 py-2.5 text-xs text-slate-500 sm:px-3">' +
              esc(r.updated_at ? new Date(r.updated_at).toLocaleString('ar') : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>'
      : '<p class="border-b border-dashed border-slate-200 py-10 text-center text-sm leading-relaxed text-slate-500">لا سجلات تدقيق لهذا الرقم — تأكد من التدقيق من الرواتب أو البحث.</p>';

    const ev = data.events || [];
    eventsBlock.innerHTML = ev.length
      ? '<div class="divide-y divide-slate-200">' +
        ev
          .map(
            (e) =>
              '<div class="py-4">' +
              '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
              '<span class="font-semibold text-slate-900">' +
              esc(e.event_type) +
              '</span>' +
              '<span class="text-[0.65rem] text-slate-400">' +
              esc(e.created_at ? new Date(e.created_at).toLocaleString('ar') : '') +
              '</span></div>' +
              '<p class="mt-2 text-sm leading-relaxed text-slate-600">' +
              esc(e.notes || '') +
              '</p></div>'
          )
          .join('') +
        '</div>'
      : '<p class="border-b border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">لا أحداث مسجّلة.</p>';

    const adj = data.adjustments || [];
    adjBlock.innerHTML = adj.length
      ? '<div class="divide-y divide-slate-200">' +
        adj
          .map(
            (a) =>
              '<div class="py-4">' +
              '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="rounded-md border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-950">' +
              esc(a.kind) +
              '</span>' +
              '<span class="font-mono text-sm font-bold tabular-nums text-slate-900" dir="ltr">' +
              esc(Number(a.amount || 0).toFixed(2)) +
              '</span>' +
              '<span class="text-xs text-slate-500">' +
              esc(a.status || '') +
              '</span></div>' +
              '<p class="mt-2 text-xs leading-relaxed text-slate-600">' +
              esc(a.notes || '') +
              '</p></div>'
          )
          .join('') +
        '</div>'
      : '<p class="border-b border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">لا تعديلات بعد.</p>';

    const ship = data.shippingTransactions || [];
    if (shippingBlock) {
      shippingBlock.innerHTML = ship.length
        ? '<div class="overflow-x-auto [-webkit-overflow-scrolling:touch]">' +
          '<table class="min-w-[560px] w-full border-collapse text-right text-sm">' +
          '<thead><tr class="border-b-2 border-slate-200/90 text-[11px] font-bold uppercase tracking-wide text-slate-500">' +
          '<th class="px-2 py-2.5 sm:px-3">#</th>' +
          '<th class="px-2 py-2.5 sm:px-3">الصنف</th>' +
          '<th class="px-2 py-2.5 sm:px-3">الكمية</th>' +
          '<th class="px-2 py-2.5 sm:px-3">الإجمالي</th>' +
          '<th class="px-2 py-2.5 sm:px-3">الربح</th>' +
          '<th class="px-2 py-2.5 sm:px-3">الحالة</th>' +
          '</tr></thead><tbody class="divide-y divide-slate-100">' +
          ship
            .map((s) => {
              const prof = s.profit_amount != null ? Number(s.profit_amount).toFixed(2) : '—';
              const pCls = s.profit_amount != null ? profitTone(s.profit_amount) : 'text-slate-500';
              return (
                '<tr class="transition-colors hover:bg-indigo-50/40">' +
                '<td class="px-2 py-2.5 font-mono text-xs text-slate-500 sm:px-3">' +
                esc(s.id) +
                '</td>' +
                '<td class="px-2 py-2.5 text-slate-800 sm:px-3">' +
                esc(s.item_type) +
                '</td>' +
                '<td class="px-2 py-2.5 font-mono tabular-nums sm:px-3" dir="ltr">' +
                esc(s.quantity) +
                '</td>' +
                '<td class="px-2 py-2.5 font-mono tabular-nums sm:px-3" dir="ltr">' +
                esc(Number(s.total || 0).toFixed(2)) +
                '</td>' +
                '<td class="px-2 py-2.5 font-mono tabular-nums font-semibold sm:px-3 ' +
                pCls +
                '" dir="ltr">' +
                esc(prof) +
                '</td>' +
                '<td class="px-2 py-2.5 text-slate-600 sm:px-3">' +
                esc(s.status || '') +
                '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table></div>'
        : '<p class="border-b border-dashed border-slate-200 py-10 text-center text-sm leading-relaxed text-slate-500">لا مبيعات شحن مسجّلة لهذا الرقم كمستخدم.</p>';
    }
    wireMdNav();
  }

  load();
})();
