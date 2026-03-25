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

  /** @returns {Promise<string>} قيمة المحدد بعد التعبئة (آخر دورة إن طُلب defaultLatest) */
  function fillCycleSelect(selId, opts) {
    opts = opts || {};
    var sel = document.getElementById(selId);
    if (!sel) return Promise.resolve('');
    return apiCall('/api/sub-agencies/cycles/list').then(function(c) {
      var cycles = c.cycles || [];
      var cur = opts.keepSelection ? sel.value : '';
      sel.innerHTML = '<option value="">— دورة (اختياري) —</option>';
      cycles.forEach(function(x) {
        sel.innerHTML += '<option value="' + x.id + '">' + (x.name || x.id) + '</option>';
      });
      if (opts.defaultLatest && cycles.length > 0) {
        sel.value = String(cycles[0].id);
      } else if (cur) {
        sel.value = cur;
      }
      return sel.value || '';
    });
  }

  function accRefreshDeliveryList(cycleId) {
    var listEl = document.getElementById('accDelList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="text-slate-400">جاري التحميل…</p>';
    var url = '/api/accreditations/with-balance';
    if (cycleId) url += '?cycleId=' + encodeURIComponent(cycleId);
    apiCall(url).then(function(res) {
      if (!listEl) return;
      if (!res.success || !(res.list || []).length) {
        listEl.innerHTML = '<p class="text-slate-500">لا يوجد معتمدون برصيد' + (cycleId ? ' له نشاط في الدورة المختارة' : '') + '</p>';
        return;
      }
      listEl.innerHTML = (res.list || []).map(function(a) {
        return '<label class="flex items-center gap-2 p-2 rounded-lg border border-slate-100 cursor-pointer hover:bg-slate-50">' +
          '<input type="checkbox" class="acc-del-cb" value="' + a.id + '">' +
          '<span class="flex-1">' + (a.name || '') + ' <span class="text-slate-400 text-xs">' + (a.code || '') + '</span></span>' +
          '<span class="font-semibold text-indigo-600">' + (a.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</span></label>';
      }).join('');
    });
  }

  window.accOpenBulk = function() {
    fillCycleSelect('accBulkCycle', { defaultLatest: true, keepSelection: false });
    var br = document.getElementById('accBulkBroker');
    if (br) br.value = '';
    document.getElementById('accBulkModal').classList.remove('hidden');
    document.getElementById('accBulkModal').classList.add('flex');
  };
  window.accCloseBulk = function() {
    document.getElementById('accBulkModal').classList.add('hidden');
    document.getElementById('accBulkModal').classList.remove('flex');
  };
  window.accSubmitBulk = function() {
    var f = document.getElementById('accBulkFile');
    if (!f || !f.files || !f.files[0]) {
      toast('اختر ملفاً', 'error');
      return;
    }
    var fd = new FormData();
    fd.append('file', f.files[0]);
    var cid = document.getElementById('accBulkCycle').value;
    if (cid) fd.append('cycleId', cid);
    fetch('/api/accreditations/bulk-balance', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        toast(res.message || '', res.success ? 'success' : 'error');
        if (res.success) {
          accCloseBulk();
          f.value = '';
          var p = document.getElementById('accBulkPaste');
          if (p) p.value = '';
          accLoad();
        }
      });
  };

  window.accSubmitBulkText = function() {
    var t = document.getElementById('accBulkPaste');
    var txt = t && t.value ? t.value.trim() : '';
    if (!txt) {
      toast('الصق النص أولاً', 'error');
      return;
    }
    var cid = document.getElementById('accBulkCycle').value;
    apiCall('/api/accreditations/bulk-balance-text', {
      method: 'POST',
      body: JSON.stringify({ csvText: txt, cycleId: cid || null })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseBulk();
        if (t) t.value = '';
        accLoad();
      }
    });
  };

  window.accSubmitBulkSheetUrl = function() {
    var u = document.getElementById('accBulkSheetUrl');
    var sn = document.getElementById('accBulkSheetName');
    var url = u && u.value ? u.value.trim() : '';
    if (!url) {
      toast('أدخل رابط الجدول', 'error');
      return;
    }
    var cid = document.getElementById('accBulkCycle').value;
    apiCall('/api/accreditations/bulk-balance-sheet-url', {
      method: 'POST',
      body: JSON.stringify({
        sheetUrl: url,
        sheetName: sn && sn.value ? sn.value.trim() : null,
        cycleId: cid || null
      })
    }).then(function(res) {
      var msg = res.message || '';
      if (res.sheetTitleUsed) msg += ' — ورقة: ' + res.sheetTitleUsed;
      toast(msg, res.success ? 'success' : 'error');
      if (res.success) {
        accCloseBulk();
        if (u) u.value = '';
        accLoad();
      }
    });
  };

  window.accOpenDelivery = function() {
    fillCycleSelect('accDelCycle');
    var listEl = document.getElementById('accDelList');
    if (listEl) listEl.innerHTML = '<p class="text-slate-400">جاري التحميل…</p>';
    document.getElementById('accDeliveryModal').classList.remove('hidden');
    document.getElementById('accDeliveryModal').classList.add('flex');
    apiCall('/api/accreditations/with-balance').then(function(res) {
      if (!listEl) return;
      if (!res.success || !(res.list || []).length) {
        listEl.innerHTML = '<p class="text-slate-500">لا يوجد معتمدون برصيد</p>';
        return;
      }
      listEl.innerHTML = (res.list || []).map(function(a) {
        return '<label class="flex items-center gap-2 p-2 rounded-lg border border-slate-100 cursor-pointer hover:bg-slate-50">' +
          '<input type="checkbox" class="acc-del-cb" value="' + a.id + '">' +
          '<span class="flex-1">' + (a.name || '') + ' <span class="text-slate-400 text-xs">' + (a.code || '') + '</span></span>' +
          '<span class="font-semibold text-indigo-600">' + (a.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</span></label>';
      }).join('');
    });
  };
  window.accCloseDelivery = function() {
    document.getElementById('accDeliveryModal').classList.add('hidden');
    document.getElementById('accDeliveryModal').classList.remove('flex');
  };
  window.accSubmitDelivery = function() {
    var boxes = document.querySelectorAll('.acc-del-cb:checked');
    var ids = [];
    boxes.forEach(function(b) { ids.push(parseInt(b.value, 10)); });
    if (!ids.length) {
      toast('حدّد معتمداً واحداً على الأقل', 'error');
      return;
    }
    var cid = document.getElementById('accDelCycle').value || null;
    apiCall('/api/accreditations/delivery-settle', {
      method: 'POST',
      body: JSON.stringify({ cycleId: cid, accreditationIds: ids })
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accCloseDelivery();
        accLoad();
      }
    });
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
