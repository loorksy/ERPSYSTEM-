(function() {
  function fmt(n) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(n);
    return (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }
  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    opts = opts || {};
    var init = Object.assign({ credentials: 'same-origin' }, opts);
    if (init.body && typeof init.body === 'string' && !init.headers) {
      init.headers = { 'Content-Type': 'application/json' };
    }
    return fetch(url, init).then(function(r) { return r.json(); });
  }

  function preview() {
    var amtUsd = parseFloat(document.getElementById('fxAmountUsd').value);
    var fixedRate = parseFloat(document.getElementById('fxInternal').value);
    var purchaseRate = parseFloat(document.getElementById('fxSettlement').value);
    var el = document.getElementById('fxPreview');
    if (!el) return;
    if (!(amtUsd > 0) || !(fixedRate > 0) || !(purchaseRate > 0)) {
      el.textContent = '';
      return;
    }
    var amountForeign = amtUsd * fixedRate;
    var profitUsd = amtUsd * Math.abs(purchaseRate - fixedRate) / purchaseRate;
    var sign = purchaseRate > fixedRate ? '+' : (purchaseRate < fixedRate ? '-' : '');
    el.innerHTML = 'المبلغ بالعملة الأجنبية: ' + fmt(amountForeign) +
      ' · ربح التصريف التقديري: <strong class="' + (profitUsd > 0 ? 'text-emerald-600' : 'text-red-600') + '">' +
      sign + fmt(profitUsd) + ' USD</strong>';
  }

  function loadList() {
    apiCall('/api/fx-spread/list').then(function(d) {
      var sel = document.getElementById('fxCycleId');
      if (sel && d.cycles && !sel.dataset.filled) {
        d.cycles.forEach(function(c) {
          sel.innerHTML += '<option value="' + c.id + '">' + (c.name || c.id) + '</option>';
        });
        sel.dataset.filled = '1';
      }
      var box = document.getElementById('fxList');
      if (!box) return;
      if (!d.success || !(d.entries || []).length) {
        box.innerHTML = '<p class="text-slate-400">لا سجلات بعد</p>';
        return;
      }
      box.innerHTML = d.entries.map(function(e) {
        return '<div class="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100">' +
          '<div><span class="font-semibold">' + (e.currency || '') + '</span> ' + fmt(e.amount_foreign) +
          ' · مثبت ' + e.internal_rate + ' / شراء ' + e.settlement_rate +
          (e.cycle_name ? ' · ' + e.cycle_name : '') +
          (e.notes ? '<br><span class="text-xs text-slate-500">' + e.notes + '</span>' : '') + '</div>' +
          '<div class="flex items-center gap-2">' +
          '<span class="font-bold text-emerald-600">' + fmt(e.spread_usd) + ' USD</span>' +
          '<button type="button" class="text-xs text-red-500 hover:underline" data-fx-del="' + e.id + '">حذف</button></div></div>';
      }).join('');
      box.querySelectorAll('[data-fx-del]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var id = btn.getAttribute('data-fx-del');
          if (!id || !confirm('حذف هذا السجل؟')) return;
          apiCall('/api/fx-spread/' + id, { method: 'DELETE' }).then(function(r) {
            toast(r.message || '', r.success ? 'success' : 'error');
            if (r.success) loadList();
          });
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    ['fxAmountUsd', 'fxInternal', 'fxSettlement'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', preview);
    });
    document.getElementById('fxSubmit')?.addEventListener('click', function() {
      var amtUsd = parseFloat(document.getElementById('fxAmountUsd').value);
      var fixedRate = parseFloat(document.getElementById('fxInternal').value);
      var purchaseRate = parseFloat(document.getElementById('fxSettlement').value);
      if (!(amtUsd > 0) || !(fixedRate > 0) || !(purchaseRate > 0)) {
        toast('أدخل المبلغ والسعرين', 'error');
        return;
      }
      var amountForeign = amtUsd * fixedRate;
      var body = {
        cycleId: document.getElementById('fxCycleId').value || null,
        currency: document.getElementById('fxCurrency').value,
        amountForeign: amountForeign,
        internalRate: fixedRate,
        settlementRate: purchaseRate,
        notes: document.getElementById('fxNotes').value || null,
      };
      var et = document.getElementById('fxEntityType').value;
      if (et) {
        body.entityType = et;
        body.entityId = document.getElementById('fxEntityId').value;
      }
      apiCall('/api/fx-spread/add', { method: 'POST', body: JSON.stringify(body) }).then(function(r) {
        toast(r.message || '', r.success ? 'success' : 'error');
        if (r.success) {
          document.getElementById('fxAmountUsd').value = '';
          preview();
          loadList();
          if (typeof window.homeLoadStats === 'function') window.homeLoadStats();
        }
      });
    });
    loadList();
  });
})();
