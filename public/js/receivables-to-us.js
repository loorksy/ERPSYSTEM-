(function() {
  'use strict';

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

  function listEmpty(msg) {
    return '<p class="text-slate-400 py-2">' + esc(msg) + '</p>';
  }

  document.addEventListener('DOMContentLoaded', function() {
    var totalEl = document.getElementById('recvToUsTotalVal');
    if (!totalEl) return;

    fetch('/dashboard/receivables-to-us', { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) {
          totalEl.textContent = '—';
          var err = d.message || 'فشل التحميل';
          var ag = document.getElementById('recvAgencies');
          if (ag) ag.innerHTML = '<p class="text-red-600">' + esc(err) + '</p>';
          return;
        }
        totalEl.textContent = fmt(d.totalUsd);

        var ag = document.getElementById('recvAgencies');
        if (ag) {
          if (!d.subAgencies || !d.subAgencies.length) {
            ag.innerHTML = listEmpty('لا يوجد دين لنا مسجّل من الوكالات (لا رصيد سالب للوكالة)');
          } else {
            ag.innerHTML = '<ul class="divide-y divide-slate-100">' + d.subAgencies.map(function(x) {
              var amt = x.amountOwedToUs != null ? x.amountOwedToUs : Math.abs(parseFloat(x.balance) || 0);
              return '<li class="py-2 flex justify-between gap-4"><span>' + esc(x.name) +
                '</span><span class="font-semibold text-emerald-700 tabular-nums">' + fmt(amt) + '</span></li>';
            }).join('') + '</ul>';
          }
        }

        var ac = document.getElementById('recvAccred');
        if (ac) {
          var alist = d.accreditations || [];
          ac.innerHTML = alist.length
            ? '<ul class="divide-y divide-slate-100">' + alist.map(function(x) {
              return '<li class="py-2 flex justify-between gap-4"><span>' + esc(x.name) +
                '</span><span class="font-semibold tabular-nums text-emerald-700">' + fmt(x.amountOwedToUs) + '</span></li>';
            }).join('') + '</ul>'
            : listEmpty('لا أرصدة معتمدين لنا');
        }

        var mb = document.getElementById('recvMembers');
        if (mb) {
          var mlist = d.members || [];
          mb.innerHTML = mlist.length
            ? '<ul class="divide-y divide-slate-100">' + mlist.map(function(x) {
              return '<li class="py-2 flex justify-between gap-4"><span class="font-mono">' + esc(x.memberUserId) +
                '</span><span class="font-semibold tabular-nums text-emerald-700">' + fmt(x.amountOwedToUs) + '</span></li>';
            }).join('') + '</ul>'
            : listEmpty('لا ديون مستخدمين على العضو');
        }

        var rt = document.getElementById('recvReturns');
        if (rt) {
          var rp = d.returnsPendingUsd != null ? d.returnsPendingUsd : 0;
          rt.textContent = rp > 0.0001 ? 'إجمالي مرتجعات معلّقة: ' + fmt(rp) : 'لا مرتجعات معلّقة مسجّلة.';
        }
      })
      .catch(function() {
        totalEl.textContent = '—';
      });
  });
})();
