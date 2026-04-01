(function() {
  'use strict';

  function fmt(n) {
    var v = parseFloat(n) || 0;
    var num = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return num + ' دولار';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sumArr(arr, key) {
    var t = 0;
    (arr || []).forEach(function(x) {
      t += Number(x[key]) || 0;
    });
    return t;
  }

  function setKpi(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = fmt(val);
  }

  function listEmpty(msg) {
    return (
      '<div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center">' +
      '<i class="fas fa-inbox mb-2 text-2xl text-slate-300"></i>' +
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
          if (ag) ag.innerHTML = '<p class="p-4 text-sm text-red-600">' + esc(err) + '</p>';
          return;
        }
        totalEl.textContent = fmt(d.totalUsd);

        var sub = d.subAgencies || [];
        var acc = d.accreditations || [];
        var mem = d.members || [];
        var tco = d.transferCompanies || [];
        var rp = d.returnsPendingUsd != null ? d.returnsPendingUsd : 0;

        setKpi('recvKpiSubAgency', sumArr(sub, 'amountOwedToUs'));
        setKpi('recvKpiAccred', sumArr(acc, 'amountOwedToUs'));
        setKpi('recvKpiMembers', sumArr(mem, 'amountOwedToUs'));
        setKpi('recvKpiReturns', rp);
        setKpi('recvKpiCompanies', sumArr(tco, 'amountOwedToUs'));

        var ag = document.getElementById('recvAgencies');
        if (ag) {
          if (!sub.length) {
            ag.innerHTML = listEmpty('لا يوجد دين لنا مسجّل من الوكالات (لا رصيد سالب للوكالة)');
          } else {
            ag.innerHTML = sub
              .map(function(x) {
                var amt = x.amountOwedToUs != null ? x.amountOwedToUs : Math.abs(parseFloat(x.balanceRaw) || 0);
                return (
                  '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-emerald-200 hover:shadow-sm">' +
                  '<span class="min-w-0 truncate text-sm font-medium text-slate-800">' +
                  esc(x.name) +
                  '</span>' +
                  '<span class="shrink-0 font-mono text-sm font-bold tabular-nums text-emerald-700">' +
                  fmt(amt) +
                  '</span></div>'
                );
              })
              .join('');
          }
        }

        var ac = document.getElementById('recvAccred');
        if (ac) {
          ac.innerHTML = acc.length
            ? acc
                .map(function(x) {
                  return (
                    '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-violet-200 hover:shadow-sm">' +
                    '<span class="min-w-0 truncate text-sm font-medium text-slate-800">' +
                    esc(x.name) +
                    '</span>' +
                    '<span class="shrink-0 font-mono text-sm font-bold tabular-nums text-emerald-700">' +
                    fmt(x.amountOwedToUs) +
                    '</span></div>'
                  );
                })
                .join('')
            : listEmpty('لا أرصدة معتمدين لنا (رصيد سالب)');
        }

        var mb = document.getElementById('recvMembers');
        if (mb) {
          mb.innerHTML = mem.length
            ? mem
                .map(function(x) {
                  return (
                    '<div class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50/90 to-white px-4 py-3.5 transition hover:border-indigo-200 hover:shadow-sm">' +
                    '<span class="font-mono text-sm text-slate-700">' +
                    esc(x.memberUserId) +
                    '</span>' +
                    '<span class="shrink-0 font-mono text-sm font-bold tabular-nums text-emerald-700">' +
                    fmt(x.amountOwedToUs) +
                    '</span></div>'
                  );
                })
                .join('')
            : listEmpty('لا ديون مسجّلة على المستخدمين');
        }

        var rt = document.getElementById('recvReturns');
        if (rt) {
          if (rp > 0.0001) {
            rt.innerHTML =
              '<span class="inline-flex items-center gap-2 rounded-xl border border-orange-100 bg-orange-50 px-4 py-3 font-mono font-bold tabular-nums text-orange-900">' +
              fmt(rp) +
              '</span><span class="mt-3 block text-xs leading-relaxed text-slate-500">مرتجعات «يبقى بالصندوق» — صافٍ بعد تسوية دين علينا إن وُجد — بالدولار — لا تشمل الترحيل لصندوق آخر ولا تُكرَّر أرصدة شركات التحويل</span>';
          } else {
            rt.innerHTML =
              '<span class="text-slate-500"><i class="fas fa-check-circle ml-1 text-emerald-500"></i> لا مرتجعات معلّقة مسجّلة.</span>';
          }
        }

        var rc = document.getElementById('recvCompanies');
        if (rc) {
          if (!tco.length) {
            rc.innerHTML = listEmpty('لا أرصدة موجبة لشركات تحويل (لنا لدى الشركة) مسجّلة حالياً');
          } else {
            rc.innerHTML = tco
              .map(function(x) {
                return (
                  '<a href="/debts/company/' +
                  esc(x.id) +
                  '" class="group flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-gradient-to-l from-cyan-50/80 to-white px-4 py-3.5 transition hover:border-cyan-200 hover:shadow-sm">' +
                  '<span class="min-w-0 truncate text-sm font-medium text-slate-800">' +
                  esc(x.name) +
                  '</span>' +
                  '<span class="shrink-0 font-mono text-sm font-bold tabular-nums text-cyan-800">' +
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
