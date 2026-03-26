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

  window.expensesLoadUnified = function() {
    var tbody = document.getElementById('expUnifiedBody');
    var src = document.getElementById('expUnifiedFilter');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-sm text-slate-400">جاري التحميل…</td></tr>';
    var q = new URLSearchParams();
    if (src && src.value) q.set('sourceType', src.value);
    apiCall('/api/expenses/ledger-unified?' + q.toString()).then(function(res) {
      if (!res.success) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-sm text-red-600">' + (res.message || 'فشل') + '</td></tr>';
        return;
      }
      var rows = res.rows || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-sm text-slate-400">لا سجلات</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function(r) {
        var d = r.created_at ? new Date(r.created_at).toLocaleString('ar-SA') : '—';
        var kind = r.source_kind === 'manual_entry' ? 'يدوي' : 'دفتر';
        return '<tr class="border-b border-slate-100 hover:bg-slate-50/80">' +
          '<td class="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">' + d + '</td>' +
          '<td class="px-3 py-2.5 font-mono text-sm tabular-nums text-slate-900">' + fmt(r.amount) + '</td>' +
          '<td class="px-3 py-2.5 text-sm text-slate-800">' + (r.source_type || '') + '</td>' +
          '<td class="px-3 py-2.5 text-xs text-slate-600">' + kind + '</td>' +
          '<td class="px-3 py-2.5 text-sm text-slate-600 max-w-xs truncate" title="' + String(r.notes || '').replace(/"/g, '&quot;') + '">' + (r.notes || '') + '</td></tr>';
      }).join('');
    });
  };

  document.addEventListener('DOMContentLoaded', function() {
    var f = document.getElementById('expForm');
    if (f) {
      f.addEventListener('submit', function(e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        fetch('/api/expenses/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            amount: fd.get('amount'),
            category: fd.get('category'),
            notes: fd.get('notes')
          })
        }).then(function(r) { return r.json(); }).then(function(res) {
          var p = document.getElementById('expMsg');
          if (p) {
            p.textContent = res.message || '';
            p.className = 'mt-3 text-sm ' + (res.success ? 'text-emerald-600' : 'text-red-600');
          }
          if (res.success) {
            e.target.reset();
            if (window.expensesLoadUnified) window.expensesLoadUnified();
            if (typeof window.homeLoadStats === 'function') window.homeLoadStats();
          }
        });
      });
    }
    var flt = document.getElementById('expUnifiedFilter');
    if (flt) {
      flt.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') window.expensesLoadUnified();
      });
    }
    if (document.getElementById('expUnifiedBody')) window.expensesLoadUnified();
  });
})();
