(function() {
  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(function(r) { return r.json(); });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }
  var defaults = [];

  function load() {
    var box = document.getElementById('tcCards');
    if (!box) return;
    apiCall('/api/transfer-companies/list').then(function(res) {
      defaults = res.defaultTransferTypes || [];
      if (!res.success) {
        box.innerHTML = '<p class="text-red-500">' + (res.message || 'فشل') + '</p>';
        return;
      }
      var list = res.companies || [];
      if (list.length === 0) {
        box.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">لا توجد شركات</p>';
        return;
      }
      box.innerHTML = list.map(function(c) {
        var types = (c.transfer_types || []).join('، ');
        return '<div class="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm cursor-pointer hover:shadow-md" onclick="tcOpen(' + c.id + ')">' +
          '<h5 class="font-bold">' + (c.name || '') + '</h5>' +
          '<p class="text-sm text-slate-600 mt-1">' + (c.country || '') + '</p>' +
          '<p class="text-sm font-semibold text-indigo-600 mt-2">' + (c.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (c.balance_currency || 'USD') + '</p>' +
          '<p class="text-xs text-slate-500 mt-1">' + types + '</p></div>';
      }).join('');
    });
  }

  window.tcOpenAdd = function() {
    var sel = document.getElementById('tcCountry');
    if (sel && window.FUNDS_COUNTRIES) {
      sel.innerHTML = window.FUNDS_COUNTRIES.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
    }
    var wrap = document.getElementById('tcTypesWrap');
    if (wrap && defaults.length) {
      wrap.innerHTML = defaults.map(function(t) {
        return '<label class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-50 border border-slate-100"><input type="checkbox" class="tcTypeCb" value="' + t + '"> ' + t + '</label>';
      }).join('');
    }
    document.getElementById('tcAddModal').classList.remove('hidden');
    document.getElementById('tcAddModal').classList.add('flex');
  };
  window.tcCloseAdd = function() {
    document.getElementById('tcAddModal').classList.add('hidden');
    document.getElementById('tcAddModal').classList.remove('flex');
  };
  window.tcOpen = function(id) {
    apiCall('/api/transfer-companies/' + id).then(function(res) {
      if (!res.success) return;
      var c = res.company;
      document.getElementById('tcDetailTitle').textContent = c.name || '';
      document.getElementById('tcDetailBal').textContent = (c.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ' + (c.balance_currency || 'USD');
      document.getElementById('tcDetailLedger').innerHTML = (res.ledger || []).map(function(l) {
        return '<div class="flex justify-between py-2 border-b border-slate-50"><span>' + (l.notes || '') + '</span><span>' + (l.amount || 0) + ' ' + (l.currency || '') + '</span></div>';
      }).join('') || '<p class="text-slate-400">لا سجل</p>';
      document.getElementById('tcDetailModal').classList.remove('hidden');
      document.getElementById('tcDetailModal').classList.add('flex');
    });
  };
  window.tcCloseDetail = function() {
    document.getElementById('tcDetailModal').classList.add('hidden');
    document.getElementById('tcDetailModal').classList.remove('flex');
  };

  document.getElementById('tcAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    var types = [];
    document.querySelectorAll('.tcTypeCb:checked').forEach(function(cb) { types.push(cb.value); });
    apiCall('/api/transfer-companies/add', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('tcName').value,
        country: document.getElementById('tcCountry').value,
        balanceAmount: document.getElementById('tcBal').value,
        balanceCurrency: document.getElementById('tcBalCur').value,
        transferTypes: types
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        tcCloseAdd();
        load();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', load);
})();
