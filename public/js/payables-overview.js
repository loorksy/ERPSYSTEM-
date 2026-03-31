(function() {
  'use strict';

  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function entityLabel(t) {
    if (t === 'fund') return 'صندوق';
    return 'شركة تحويل';
  }

  function rowCompany(c) {
    return (
      '<a href="/debts/company/' +
      esc(c.id) +
      '" class="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-red-50/70">' +
      '<div class="flex min-w-0 items-center gap-3">' +
      '<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700 group-hover:bg-red-600 group-hover:text-white transition"><i class="fas fa-building text-sm"></i></span>' +
      '<span class="font-semibold text-slate-900 truncate">' +
      esc(c.name || '') +
      '</span></div>' +
      '<span class="font-mono text-sm font-bold tabular-nums text-rose-700 shrink-0">' +
      fmt(c.balance_amount) +
      '</span></a>'
    );
  }

  function rowFund(f) {
    return (
      '<a href="/debts/fund/' +
      esc(f.id) +
      '" class="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-amber-50/70">' +
      '<div class="flex min-w-0 items-center gap-3">' +
      '<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800 group-hover:bg-amber-600 group-hover:text-white transition"><i class="fas fa-piggy-bank text-sm"></i></span>' +
      '<span class="font-semibold text-slate-900 truncate">' +
      esc(f.name || '') +
      '</span></div>' +
      '<span class="font-mono text-sm font-bold tabular-nums text-amber-900 shrink-0">' +
      fmt(f.amount) +
      '</span></a>'
    );
  }

  document.addEventListener('DOMContentLoaded', function() {
    var hero = document.getElementById('payablesHeroTotal');
    var tb = document.getElementById('payablesTableBody');
    if (!hero || !tb) return;

    fetch('/api/payables/overview', { credentials: 'same-origin' })
      .then(function(r) {
        return r.json();
      })
      .then(function(res) {
        if (!res.success || !res.breakdown) {
          hero.textContent = '—';
          tb.innerHTML =
            '<tr><td colspan="4" class="px-4 py-8 text-center text-red-600">' +
            esc(res.message || 'فشل التحميل') +
            '</td></tr>';
          return;
        }
        var b = res.breakdown;
        hero.textContent = fmt(b.totalDebts);

        var set = function(id, v) {
          var el = document.getElementById(id);
          if (el) el.textContent = fmt(v);
        };
        set('payablesKpiShipping', b.shippingDebt);
        set('payablesKpiAcc', b.accreditationPayableUsd != null ? b.accreditationPayableUsd : b.accreditationDebtTotal);
        set('payablesKpiManual', b.payablesSumUsd);
        set('payablesKpiCo', b.companyDebtFromBalance);
        set('payablesKpiFund', b.fundDebtFromBalance);
        set('payablesKpiFx', b.fxSpreadSumUsd != null ? b.fxSpreadSumUsd : 0);

        var nc = document.getElementById('payablesNegCompanies');
        if (nc) {
          nc.innerHTML = (res.negativeCompanies || []).length
            ? (res.negativeCompanies || []).map(rowCompany).join('')
            : '<p class="px-4 py-8 text-center text-sm text-slate-400">لا توجد شركات برصيد سالب</p>';
        }
        var nf = document.getElementById('payablesNegFunds');
        if (nf) {
          nf.innerHTML = (res.negativeFunds || []).length
            ? (res.negativeFunds || []).map(rowFund).join('')
            : '<p class="px-4 py-8 text-center text-sm text-slate-400">لا توجد صناديق برصيد سالب</p>';
        }

        var rows = (res.payables || []).slice(0, 50);
        if (!rows.length) {
          tb.innerHTML =
            '<tr><td colspan="4" class="px-4 py-10 text-center text-slate-400">لا توجد سجلات يدوية</td></tr>';
          return;
        }
        tb.innerHTML = rows
          .map(function(p) {
            return (
              '<tr class="hover:bg-slate-50/80 transition">' +
              '<td class="px-4 py-3 font-medium text-slate-800">' +
              esc(entityLabel(p.entity_type)) +
              '</td>' +
              '<td class="px-4 py-3 font-mono text-xs text-slate-600">#' +
              esc(String(p.entity_id)) +
              '</td>' +
              '<td class="px-4 py-3 text-left font-mono font-semibold tabular-nums text-slate-900" dir="ltr">' +
              fmt(p.amount) +
              ' ' +
              esc(p.currency || '') +
              '</td>' +
              '<td class="px-4 py-3 text-slate-500 hidden sm:table-cell max-w-xs truncate">' +
              esc(p.notes || '—') +
              '</td></tr>'
            );
          })
          .join('');
      })
      .catch(function() {
        hero.textContent = '—';
        tb.innerHTML =
          '<tr><td colspan="4" class="px-4 py-8 text-center text-red-600">فشل الاتصال</td></tr>';
      });
  });
})();
