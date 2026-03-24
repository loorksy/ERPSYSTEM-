(function() {
  var currentId = null;
  var currentPinned = false;

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(function(r) { return r.json(); });
  }
  function toast(m, t) {
    if (typeof window.showToast === 'function') window.showToast(m, t);
    else alert(m);
  }

  window.accLoad = function() {
    var box = document.getElementById('accCards');
    if (!box) return;
    apiCall('/api/accreditations/list').then(function(res) {
      if (!res.success) {
        box.innerHTML = '<p class="text-red-500">' + (res.message || '') + '</p>';
        return;
      }
      var list = res.list || [];
      if (list.length === 0) {
        box.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">لا يوجد معتمدون</p>';
        return;
      }
      box.innerHTML = list.map(function(a) {
        var pin = a.pinned ? '<i class="fas fa-thumbtack text-amber-500 ml-1"></i>' : '';
        return '<div class="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm cursor-pointer hover:shadow-md" onclick="accOpen(' + a.id + ')">' +
          pin + '<h5 class="font-bold">' + (a.name || '') + '</h5>' +
          '<p class="text-xs text-slate-500">' + (a.code || '') + '</p>' +
          '<p class="text-indigo-600 font-semibold mt-2">' + (a.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</p></div>';
      }).join('');
    });
  };

  window.accOpenAdd = function() {
    document.getElementById('accAddModal').classList.remove('hidden');
    document.getElementById('accAddModal').classList.add('flex');
  };
  window.accCloseAdd = function() {
    document.getElementById('accAddModal').classList.add('hidden');
    document.getElementById('accAddModal').classList.remove('flex');
  };

  window.accOpen = function(id) {
    currentId = id;
    apiCall('/api/accreditations/' + id).then(function(res) {
      if (!res.success) return;
      var e = res.entity;
      currentPinned = !!e.pinned;
      document.getElementById('accDetailTitle').textContent = e.name || '';
      document.getElementById('accDetailBal').textContent = 'الرصيد: ' + (e.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
      document.getElementById('accLedger').innerHTML = (res.ledger || []).map(function(l) {
        return '<div class="py-2 border-b border-slate-50 flex justify-between"><span>' + (l.entry_type || '') + '</span><span>' + (l.amount || 0) + '</span></div>';
      }).join('') || '<p class="text-slate-400">فارغ</p>';
      document.getElementById('accAddAmountPanel').classList.add('hidden');
      document.getElementById('accTransferPanel').classList.add('hidden');
      apiCall('/api/sub-agencies/cycles/list').then(function(c) {
        var sel = document.getElementById('accCycle');
        sel.innerHTML = '<option value="">— دورة —</option>';
        (c.cycles || []).forEach(function(x) {
          sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
        });
      });
      apiCall('/api/funds/list').then(function(f) {
        var s = document.getElementById('accTfFund');
        s.innerHTML = '<option value="">— صندوق —</option>';
        (f.funds || []).forEach(function(x) {
          s.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
        });
      });
      apiCall('/api/transfer-companies/list').then(function(t) {
        var s = document.getElementById('accTfCompany');
        s.innerHTML = '<option value="">— شركة —</option>';
        (t.companies || []).forEach(function(x) {
          s.innerHTML += '<option value="' + x.id + '">' + (x.name || '') + '</option>';
        });
      });
      document.getElementById('accDetailModal').classList.remove('hidden');
      document.getElementById('accDetailModal').classList.add('flex');
    });
  };
  window.accCloseDetail = function() {
    document.getElementById('accDetailModal').classList.add('hidden');
    document.getElementById('accDetailModal').classList.remove('flex');
    currentId = null;
  };

  window.accShowAddAmount = function() {
    document.getElementById('accAddAmountPanel').classList.toggle('hidden');
  };
  window.accShowTransfer = function() {
    document.getElementById('accTransferPanel').classList.toggle('hidden');
    accTfTypeChange();
  };
  window.accTfTypeChange = function() {
    var t = document.getElementById('accTfType').value;
    document.getElementById('accTfFund').classList.toggle('hidden', t !== 'fund');
    document.getElementById('accTfCompany').classList.toggle('hidden', t !== 'company');
    document.getElementById('accTfShipHint').classList.toggle('hidden', t !== 'shipping');
  };

  window.accSubmitAmount = function() {
    if (!currentId) return;
    apiCall('/api/accreditations/' + currentId + '/add-amount', {
      method: 'POST',
      body: JSON.stringify({
        salaryDirection: document.getElementById('accSalaryDir').value,
        amount: document.getElementById('accAmt').value,
        brokeragePct: document.getElementById('accBroker').value,
        cycleId: document.getElementById('accCycle').value || null
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) accOpen(currentId);
    });
  };

  window.accSubmitTransfer = function() {
    if (!currentId) return;
    var t = document.getElementById('accTfType').value;
    var body = {
      transferType: t === 'fund' ? 'fund' : t === 'company' ? 'company' : 'manual',
      amount: document.getElementById('accTfAmt').value,
      fundId: document.getElementById('accTfFund').value,
      companyId: document.getElementById('accTfCompany').value
    };
    apiCall('/api/accreditations/' + currentId + '/transfer', { method: 'POST', body: JSON.stringify(body) }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) accOpen(currentId);
    });
  };

  window.accTogglePin = function() {
    if (!currentId) return;
    apiCall('/api/accreditations/' + currentId + '/pin', {
      method: 'POST',
      body: JSON.stringify({ pinned: !currentPinned })
    }).then(function(res) {
      if (res.success) {
        currentPinned = !currentPinned;
        accLoad();
      }
    });
  };

  document.getElementById('accAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    apiCall('/api/accreditations/add', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('accName').value,
        code: document.getElementById('accCode').value
      })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseAdd();
        accLoad();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', accLoad);
})();
