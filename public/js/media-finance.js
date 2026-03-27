(function () {
  'use strict';
  var box = document.getElementById('mediaFinanceBox');
  if (!box) return;
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  fetch('/api/expenses/media-finance-ledger', { credentials: 'same-origin' })
    .then(function (r) {
      return r.json();
    })
    .then(function (res) {
      if (!res.success) {
        box.innerHTML = '<p class="p-8 text-center text-sm text-red-600">' + esc(res.message || 'فشل') + '</p>';
        return;
      }
      var rows = res.rows || [];
      if (!rows.length) {
        box.innerHTML =
          '<p class="p-8 text-center text-sm text-slate-500">لا سجلات بعد. عند إدخال مصروف يدوي اختر التصنيف <strong>media_finance</strong> أو أضف «وسائط» في الملاحظات.</p>';
        return;
      }
      box.innerHTML =
        '<div class="overflow-x-auto"><table class="w-full text-right text-sm">' +
        '<thead><tr class="bg-slate-100/90 text-slate-700 border-b border-slate-200">' +
        '<th class="px-3 py-2 text-xs">#</th><th class="px-3 py-2 text-xs">المبلغ</th><th class="px-3 py-2 text-xs">التصنيف</th>' +
        '<th class="px-3 py-2 text-xs">ملاحظات</th><th class="px-3 py-2 text-xs">التاريخ</th></tr></thead><tbody>' +
        rows
          .map(function (r) {
            return (
              '<tr class="border-b border-slate-100">' +
              '<td class="px-3 py-2 font-mono text-xs">' +
              esc(r.id) +
              '</td>' +
              '<td class="px-3 py-2 tabular-nums font-semibold text-indigo-800">' +
              fmt(r.amount) +
              '</td>' +
              '<td class="px-3 py-2 text-xs">' +
              esc(r.category) +
              '</td>' +
              '<td class="px-3 py-2 text-xs max-w-[16rem]">' +
              esc(r.notes) +
              '</td>' +
              '<td class="px-3 py-2 text-xs text-slate-500">' +
              esc(r.created_at ? new Date(r.created_at).toLocaleString('ar') : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    })
    .catch(function () {
      box.innerHTML = '<p class="p-8 text-center text-sm text-red-600">فشل التحميل</p>';
    });
})();
