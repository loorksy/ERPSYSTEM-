(function() {
  'use strict';

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(function(r) { return r.json(); });
  }
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
  }

  document.addEventListener('DOMContentLoaded', function() {
    var box = document.getElementById('profitSourcesBox');
    if (!box) return;
    apiCall('/api/expenses/net-profit-by-source').then(function(res) {
      if (!res.success) {
        box.innerHTML = '<p class="p-6 text-center text-red-500">' + (res.message || 'فشل') + '</p>';
        return;
      }
      var rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML = '<p class="p-6 text-center text-slate-400">لا توجد قيود صافي ربح بعد</p>';
        return;
      }
      box.innerHTML =
        '<table class="w-full text-right text-sm">' +
        '<thead><tr class="bg-slate-50 border-b border-slate-200">' +
        '<th class="px-4 py-3 font-semibold text-slate-700">نوع المصدر</th>' +
        '<th class="px-4 py-3 font-semibold text-slate-700">الإجمالي</th></tr></thead><tbody>' +
        rows.map(function(r) {
          return '<tr class="border-b border-slate-100">' +
            '<td class="px-4 py-2.5 font-mono text-xs text-slate-800">' + (r.source_type || '') + '</td>' +
            '<td class="px-4 py-2.5 font-semibold text-emerald-700">' + fmt(r.total) + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    });
  });
})();
