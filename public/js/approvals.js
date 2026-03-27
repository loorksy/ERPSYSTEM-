(function() {
  var currentId = null;
  var currentPinned = false;
  var accBulkStagingItems = [];

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function accShowStagingFromPreview(preview) {
    var valid = (preview || []).filter(function(r) { return r.valid; });
    if (!valid.length) {
      toast('لا توجد صفوف صالحة', 'error');
      return;
    }
    accBulkStagingItems = valid.map(function(r) {
      return {
        lineIndex: r.lineIndex,
        code: r.code,
        name: r.name,
        amount: r.amount,
        parentRef: r.parentRef || '',
        brokeragePct: '',
        salaryDirection: 'to_us',
        amountKind: 'salary',
      };
    });
    accRenderStagingTable();
    var st = document.getElementById('accBulkStaging');
    if (st) st.classList.remove('hidden');
  }

  function accRenderStagingTable() {
    var tb = document.getElementById('accBulkStagingTable');
    if (!tb) return;
    var br = document.getElementById('accBulkBroker');
    var defB = br && br.value !== '' && br.value != null ? br.value : '0';
    var html = '<table class="min-w-full text-right border-collapse text-xs"><thead><tr class="border-b bg-slate-50">' +
      '<th class="p-2">#</th><th class="p-2">كود</th><th class="p-2">اسم</th><th class="p-2">مبلغ</th><th class="p-2">وساطة %</th><th class="p-2">اتجاه</th><th class="p-2">نوع</th><th class="p-2"></th></tr></thead><tbody>';
    accBulkStagingItems.forEach(function(row, idx) {
      var bpVal = row.brokeragePct !== '' && row.brokeragePct != null && row.brokeragePct !== undefined ? row.brokeragePct : defB;
      html += '<tr class="border-b border-slate-100">' +
        '<td class="p-1">' + (row.lineIndex != null ? row.lineIndex : idx + 1) + '</td>' +
        '<td class="p-1">' + escHtml(row.code) + '</td>' +
        '<td class="p-1">' + escHtml(row.name) + '</td>' +
        '<td class="p-1">' + escHtml(row.amount) + '</td>' +
        '<td class="p-1"><input type="number" min="0" max="100" step="0.01" class="acc-bulk-bp w-20 px-1 py-1 border rounded" data-idx="' + idx + '" value="' + escHtml(bpVal) + '"></td>' +
        '<td class="p-1"><select class="acc-bulk-dir w-28 px-1 py-1 border rounded" data-idx="' + idx + '">' +
        '<option value="to_us"' + (row.salaryDirection === 'to_us' ? ' selected' : '') + '>راتب لنا</option>' +
        '<option value="to_them"' + (row.salaryDirection === 'to_them' ? ' selected' : '') + '>علينا</option></select></td>' +
        '<td class="p-1"><select class="acc-bulk-kind w-32 px-1 py-1 border rounded" data-idx="' + idx + '">' +
        '<option value="salary"' + (row.amountKind === 'salary' ? ' selected' : '') + '>راتب</option>' +
        '<option value="debt_to_us"' + (row.amountKind === 'debt_to_us' ? ' selected' : '') + '>دين لنا</option></select></td>' +
        '<td class="p-1"><button type="button" class="text-red-600" onclick="accRemoveStagingRow(' + idx + ')">حذف</button></td></tr>';
    });
    html += '</tbody></table>';
    tb.innerHTML = html;
    tb.querySelectorAll('.acc-bulk-bp').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var i = parseInt(inp.getAttribute('data-idx'), 10);
        if (!isNaN(i) && accBulkStagingItems[i]) accBulkStagingItems[i].brokeragePct = inp.value;
      });
    });
    tb.querySelectorAll('.acc-bulk-dir').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var i = parseInt(sel.getAttribute('data-idx'), 10);
        if (!isNaN(i) && accBulkStagingItems[i]) accBulkStagingItems[i].salaryDirection = sel.value;
      });
    });
    tb.querySelectorAll('.acc-bulk-kind').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var i = parseInt(sel.getAttribute('data-idx'), 10);
        if (!isNaN(i) && accBulkStagingItems[i]) accBulkStagingItems[i].amountKind = sel.value;
      });
    });
  }

  window.accRemoveStagingRow = function(idx) {
    accBulkStagingItems.splice(idx, 1);
    if (!accBulkStagingItems.length) {
      accClearBulkStaging();
      return;
    }
    accRenderStagingTable();
  };

  window.accClearBulkStaging = function() {
    accBulkStagingItems = [];
    var st = document.getElementById('accBulkStaging');
    if (st) st.classList.add('hidden');
    var tb = document.getElementById('accBulkStagingTable');
    if (tb) tb.innerHTML = '';
  };

  window.accCommitBulk = function() {
    if (!accBulkStagingItems.length) {
      toast('لا توجد صفوف', 'error');
      return;
    }
    var cid = document.getElementById('accBulkCycle').value;
    var defBr = document.getElementById('accBulkBroker') ? document.getElementById('accBulkBroker').value : '';
    var items = accBulkStagingItems.map(function(r) {
      return {
        code: r.code,
        name: r.name,
        amount: r.amount,
        parentRef: r.parentRef,
        brokeragePct: r.brokeragePct !== '' && r.brokeragePct != null ? r.brokeragePct : defBr,
        salaryDirection: r.salaryDirection,
        amountKind: r.amountKind,
      };
    });
    apiCall('/api/accreditations/bulk-balance-commit', {
      method: 'POST',
      body: JSON.stringify({ cycleId: cid || null, items: items, defaultBrokeragePct: defBr || null }),
    }).then(function(res) {
      toast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        accClearBulkStaging();
        accCloseBulk();
        var f = document.getElementById('accBulkFile');
        if (f) f.value = '';
        var p = document.getElementById('accBulkPaste');
        if (p) p.value = '';
        var u = document.getElementById('accBulkSheetUrl');
        if (u) u.value = '';
        accLoad();
      }
    });
  };

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
    accClearBulkStaging();
    fillCycleSelect('accBulkCycle', { defaultLatest: true, keepSelection: false });
    var br = document.getElementById('accBulkBroker');
    if (br) {
      br.value = '';
      if (!br.dataset.bound) {
        br.dataset.bound = '1';
        br.addEventListener('input', function() {
          if (accBulkStagingItems.length) accRenderStagingTable();
        });
      }
    }
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
    fetch('/api/accreditations/bulk-balance-parse-file', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.success) {
          toast(res.message || 'فشل', 'error');
          return;
        }
        accShowStagingFromPreview(res.preview || []);
        toast('راجع الصفوف ثم اضغط حفظ الكل', 'success');
      });
  };

  window.accSubmitBulkText = function() {
    var t = document.getElementById('accBulkPaste');
    var txt = t && t.value ? t.value.trim() : '';
    if (!txt) {
      toast('الصق النص أولاً', 'error');
      return;
    }
    apiCall('/api/accreditations/bulk-balance-parse-text', {
      method: 'POST',
      body: JSON.stringify({ csvText: txt }),
    }).then(function(res) {
      if (!res.success) {
        toast(res.message || 'فشل', 'error');
        return;
      }
      accShowStagingFromPreview(res.preview || []);
      toast('راجع الصفوف ثم اضغط حفظ الكل', 'success');
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
    apiCall('/api/accreditations/bulk-balance-parse-sheet-url', {
      method: 'POST',
      body: JSON.stringify({
        sheetUrl: url,
        sheetName: sn && sn.value ? sn.value.trim() : null,
      }),
    }).then(function(res) {
      if (!res.success) {
        toast(res.message || 'فشل', 'error');
        return;
      }
      var extra = res.sheetTitleUsed ? ' — ' + res.sheetTitleUsed : '';
      accShowStagingFromPreview(res.preview || []);
      toast('تمت المعاينة' + extra, 'success');
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

  window.accAmountKindChange = function() {
    var k = document.getElementById('accAmountKind');
    var show = !k || k.value === 'salary';
    document.querySelectorAll('.acc-salary-only').forEach(function(el) {
      el.classList.toggle('hidden', !show);
    });
  };

  window.accShowAddAmount = function() {
    document.getElementById('accAddAmountPanel').classList.toggle('hidden');
    var ak = document.getElementById('accAmountKind');
    if (ak) ak.value = 'salary';
    accAmountKindChange();
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
        amountKind: document.getElementById('accAmountKind') ? document.getElementById('accAmountKind').value : 'salary',
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

  document.addEventListener('DOMContentLoaded', function() {
    accLoad();
    accAmountKindChange();
  });
})();
