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
    return (
      '<div class="flex flex-col items-center justify-center py-10 px-4 text-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60">' +
      '<i class="fas fa-inbox text-2xl text-slate-300 mb-2"></i>' +
      '<p class="text-sm text-slate-500">' +
      esc(msg) +
      '</p></div>'
    );
  }

  document.addEventListener('DOMContentLoaded', function() {
    var totalEl = document.getElementById('recvToUsTotalVal');
    if (!totalEl) return;

    fetch('/dashboard/receivables-to-us', { credentials: 'same-origin' })
      .then(function(r) {
        return r.json();
      })
      .then(function(d) {
        if (!d.success) {
          totalEl.textContent = '—';
          var err = d.message || 'فشل التحميل';
          var ag = document.getElementById('recvAgencies');
          if (ag) ag.innerHTML = '<p class="text-red-600 text-sm p-4">' + esc(err) + '</p>';
          return;
        }
        totalEl.textContent = fmt(d.totalUsd);

        var ag = document.getElementById('recvAgencies');
        if (ag) {
          if (!d.subAgencies || !d.subAgencies.length) {
            ag.innerHTML = listEmpty('لا يوجد دين لنا مسجّل من الوكالات (لا رصيد سالب للوكالة)');
          } else {
            ag.innerHTML = d.subAgencies
              .map(function(x) {
                var amt = x.amountOwedToUs != null ? x.amountOwedToUs : Math.abs(parseFloat(x.balanceRaw) || 0);
                return (
                  '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-emerald-200 hover:shadow-sm">' +
                  '<span class="text-sm font-medium text-slate-800 min-w-0 truncate">' +
                  esc(x.name) +
                  '</span>' +
                  '<span class="font-mono text-sm font-bold tabular-nums shrink-0 text-emerald-700">' +
                  fmt(amt) +
                  '</span></div>'
                );
              })
              .join('');
          }
        }

        var ac = document.getElementById('recvAccred');
        if (ac) {
          var alist = d.accreditations || [];
          ac.innerHTML = alist.length
            ? alist
                .map(function(x) {
                  return (
                    '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-violet-200 hover:shadow-sm">' +
                    '<span class="text-sm font-medium text-slate-800 min-w-0 truncate">' +
                    esc(x.name) +
                    '</span>' +
                    '<span class="font-mono text-sm font-bold tabular-nums shrink-0 text-emerald-700">' +
                    fmt(x.amountOwedToUs) +
                    '</span></div>'
                  );
                })
                .join('')
            : listEmpty('لا أرصدة معتمدين لنا (رصيد سالب)');
        }

        var mb = document.getElementById('recvMembers');
        if (mb) {
          var mlist = d.members || [];
          mb.innerHTML = mlist.length
            ? mlist
                .map(function(x) {
                  return (
                    '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-indigo-200 hover:shadow-sm">' +
                    '<span class="font-mono text-sm text-slate-700">' +
                    esc(x.memberUserId) +
                    '</span>' +
                    '<span class="font-mono text-sm font-bold tabular-nums shrink-0 text-emerald-700">' +
                    fmt(x.amountOwedToUs) +
                    '</span></div>'
                  );
                })
                .join('')
            : listEmpty('لا ديون مستخدمين على العضو');
        }

        var rt = document.getElementById('recvReturns');
        if (rt) {
          var rp = d.returnsPendingUsd != null ? d.returnsPendingUsd : 0;
          if (rp > 0.0001) {
            rt.innerHTML =
              '<span class="inline-flex items-center gap-2 rounded-xl bg-orange-50 border border-orange-100 px-4 py-3 font-mono font-bold text-orange-900 tabular-nums">' +
              fmt(rp) +
              '</span><span class="block mt-3 text-xs text-slate-500">إجمالي مرتجعات معلّقة (USD تقريباً)</span>';
          } else {
            rt.innerHTML =
              '<span class="text-slate-500"><i class="fas fa-check-circle text-emerald-500 ml-1"></i> لا مرتجعات معلّقة مسجّلة.</span>';
          }
        }

        var rc = document.getElementById('recvCompanies');
        if (rc) {
          var tco = d.transferCompanies || [];
          if (!tco.length) {
            rc.innerHTML = listEmpty('لا أرصدة موجبة لشركات تحويل (لنا لدى الشركة) مسجّلة حالياً');
          } else {
            rc.innerHTML = tco
              .map(function(x) {
                return (
                  '<a href="/debts/company/' +
                  esc(x.id) +
                  '" class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-cyan-50/80 to-white px-4 py-3.5 transition hover:border-cyan-200 hover:shadow-sm">' +
                  '<span class="text-sm font-medium text-slate-800 min-w-0 truncate">' +
                  esc(x.name) +
                  '</span>' +
                  '<span class="font-mono text-sm font-bold tabular-nums shrink-0 text-cyan-800">' +
                  fmt(x.amountOwedToUs != null ? x.amountOwedToUs : 0) +
                  '</span></a>'
                );
              })
              .join('');
          }
        }
      })
      .catch(function() {
        totalEl.textContent = '—';
      });
  });
})();
