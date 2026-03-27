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

  function accSyncBulkStep() {
    var modal = document.getElementById('accBulkModal');
    if (!modal) return;
    var st = document.getElementById('accBulkStaging');
    var reviewing = !!(st && !st.classList.contains('hidden') && accBulkStagingItems.length > 0);
    modal.setAttribute('data-acc-step', reviewing ? 'review' : 'import');
  }

  function accScrollBulkModalToStaging() {
    var body = document.getElementById('accBulkModalBody');
    var st = document.getElementById('accBulkStaging');
    if (!body || !st) return;
    var rect = st.getBoundingClientRect();
    var bodyRect = body.getBoundingClientRect();
    var top = rect.top - bodyRect.top + body.scrollTop;
    body.scrollTop = Math.max(0, top - 4);
  }

  function accResetBulkStagingTableScroll() {
    var wrap = document.querySelector('#accBulkStagingTable .acc-bulk-scroll');
    if (!wrap) return;
    wrap.scrollTop = 0;
    wrap.scrollLeft = 0;
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
    accSyncBulkStep();
    accResetBulkStagingTableScroll();
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        accScrollBulkModalToStaging();
        accResetBulkStagingTableScroll();
      });
    });
  }

  function accRenderStagingTable() {
    var tb = document.getElementById('accBulkStagingTable');
    if (!tb) return;
    var badge = document.getElementById('accBulkStagingBadge');
    var badgeText = badge && badge.querySelector('.acc-bulk-badge-text');
    if (badgeText) badgeText.textContent = accBulkStagingItems.length + ' صف';
    else if (badge) badge.textContent = accBulkStagingItems.length + ' صف';
    var br = document.getElementById('accBulkBroker');
    var defB = br && br.value !== '' && br.value != null ? br.value : '0';
    if (!accBulkStagingItems.length) {
      tb.innerHTML = '';
      return;
    }

    function rowBp(row, idx) {
      var bpVal = row.brokeragePct !== '' && row.brokeragePct != null && row.brokeragePct !== undefined ? row.brokeragePct : defB;
      return { bpVal: bpVal, lineNum: row.lineIndex != null ? row.lineIndex : idx + 1 };
    }

    function accBulkBpInputValue(bpVal, defB) {
      var v = bpVal !== '' && bpVal != null && bpVal !== undefined ? String(bpVal) : String(defB !== '' && defB != null ? defB : '0');
      if (v === '.' || v === '-' || v === '+' || v === '..' || v.trim() === '') v = '0';
      return v;
    }

    var rows = accBulkStagingItems.map(function(row, idx) {
      var r = rowBp(row, idx);
      return (
        '<tr class="acc-bulk-tr border-b border-slate-100 hover:bg-indigo-50/25 transition-colors">' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle text-slate-600 tabular-nums whitespace-nowrap" data-label="#"><span class="acc-bulk-val">' + escHtml(r.lineNum) + '</span></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle font-mono text-sm text-slate-800" data-label="كود"><span class="acc-bulk-val">' + escHtml(row.code) + '</span></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle font-medium text-slate-900 min-w-0" data-label="الاسم"><span class="acc-bulk-val line-clamp-3 break-words inline-block max-w-full">' + escHtml(row.name) + '</span></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle text-indigo-700 font-semibold tabular-nums whitespace-nowrap" data-label="المبلغ"><span class="acc-bulk-val">' + escHtml(row.amount) + '</span></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle" data-label="وساطة %">' +
        '<input type="number" min="0" max="100" step="0.01" class="acc-bulk-bp w-full max-w-full sm:max-w-[5.5rem] min-h-[40px] sm:min-h-[40px] px-3 py-2 sm:py-1.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400" data-idx="' + idx + '" value="' + escHtml(accBulkBpInputValue(r.bpVal, defB)) + '"></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle" data-label="الاتجاه">' +
        '<select class="acc-bulk-dir w-full max-w-full min-w-0 min-h-[40px] sm:min-h-[40px] px-3 py-2 sm:py-2 rounded-xl border border-slate-200 text-sm bg-white focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400" data-idx="' + idx + '">' +
        '<option value="to_us"' + (row.salaryDirection === 'to_us' ? ' selected' : '') + '>راتب لنا</option>' +
        '<option value="to_them"' + (row.salaryDirection === 'to_them' ? ' selected' : '') + '>راتب علينا</option></select></td>' +
        '<td class="acc-bulk-td p-2 sm:p-3 align-middle" data-label="النوع">' +
        '<select class="acc-bulk-kind w-full max-w-full min-w-0 min-h-[40px] sm:min-h-[40px] px-3 py-2 sm:py-2 rounded-xl border border-slate-200 text-sm bg-white focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400" data-idx="' + idx + '">' +
        '<option value="salary"' + (row.amountKind === 'salary' ? ' selected' : '') + '>راتب</option>' +
        '<option value="debt_to_us"' + (row.amountKind === 'debt_to_us' ? ' selected' : '') + '>دين لنا</option></select></td>' +
        '<td class="acc-bulk-td acc-bulk-td-actions p-2 sm:p-3 align-middle whitespace-nowrap" data-label="إجراء">' +
        '<button type="button" class="min-h-[40px] sm:min-h-0 w-full sm:w-auto px-4 py-2 sm:py-0 rounded-xl border border-red-100 sm:border-0 bg-red-50/80 sm:bg-transparent text-red-600 text-sm font-semibold hover:bg-red-100 sm:hover:bg-transparent sm:hover:underline" data-acc-delete="' + idx + '">حذف</button></td></tr>'
      );
    }).join('');

    var colgroup =
      '<colgroup>' +
      '<col style="width:3%">' +
      '<col style="width:8%">' +
      '<col style="width:26%">' +
      '<col style="width:10%">' +
      '<col style="width:8%">' +
      '<col style="width:18%">' +
      '<col style="width:15%">' +
      '<col style="width:12%">' +
      '</colgroup>';

    var thead =
      '<thead class="acc-bulk-thead">' +
      '<tr class="border-b border-slate-100 bg-slate-50 text-slate-700">' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold whitespace-nowrap"><span class="inline-flex items-center gap-1.5"><i class="fas fa-hashtag text-[0.65rem] text-slate-400" aria-hidden="true"></i>#</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold whitespace-nowrap"><span class="inline-flex items-center gap-1.5"><i class="fas fa-barcode text-[0.65rem] text-slate-400" aria-hidden="true"></i>كود</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold"><span class="inline-flex items-center gap-1.5"><i class="fas fa-user text-[0.65rem] text-slate-400" aria-hidden="true"></i>الاسم</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold whitespace-nowrap"><span class="inline-flex items-center gap-1.5"><i class="fas fa-coins text-[0.65rem] text-slate-400" aria-hidden="true"></i>المبلغ</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold whitespace-nowrap"><span class="inline-flex items-center gap-1.5"><i class="fas fa-percent text-[0.65rem] text-slate-400" aria-hidden="true"></i>وساطة %</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold"><span class="inline-flex items-center gap-1.5"><i class="fas fa-right-left text-[0.65rem] text-slate-400" aria-hidden="true"></i>الاتجاه</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold"><span class="inline-flex items-center gap-1.5"><i class="fas fa-tag text-[0.65rem] text-slate-400" aria-hidden="true"></i>النوع</span></th>' +
      '<th class="p-2 sm:p-3 text-xs sm:text-sm font-bold w-16"><span class="inline-flex items-center gap-1.5"><i class="fas fa-cog text-[0.65rem] text-slate-400" aria-hidden="true"></i></span></th>' +
      '</tr></thead>';

    tb.innerHTML =
      '<div class="acc-bulk-scroll max-h-[min(38vh,18rem)] sm:max-h-[min(52vh,30rem)] lg:max-h-[min(60vh,38rem)] overflow-y-auto overflow-x-auto overscroll-contain [-webkit-overflow-scrolling:touch]">' +
      '<table class="acc-bulk-review w-full min-w-0 text-right border-collapse text-sm">' +
      colgroup +
      thead +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function wireAccBulkStagingDelegation() {
    var c = document.getElementById('accBulkStagingTable');
    if (!c || c.dataset.accBulkBound) return;
    c.dataset.accBulkBound = '1';
    c.addEventListener('change', function(e) {
      var t = e.target;
      var idx = parseInt(t.getAttribute('data-idx'), 10);
      if (isNaN(idx) || !accBulkStagingItems[idx]) return;
      if (t.classList.contains('acc-bulk-dir')) accBulkStagingItems[idx].salaryDirection = t.value;
      if (t.classList.contains('acc-bulk-kind')) accBulkStagingItems[idx].amountKind = t.value;
    });
    c.addEventListener('input', function(e) {
      var t = e.target;
      if (!t.classList.contains('acc-bulk-bp')) return;
      var idx = parseInt(t.getAttribute('data-idx'), 10);
      if (isNaN(idx) || !accBulkStagingItems[idx]) return;
      accBulkStagingItems[idx].brokeragePct = t.value;
    });
    c.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-acc-delete]');
      if (!btn) return;
      e.preventDefault();
      var idx = parseInt(btn.getAttribute('data-acc-delete'), 10);
      if (!isNaN(idx)) window.accRemoveStagingRow(idx);
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
    accSyncBulkStep();
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
        accBulkClearFileNameDisplay();
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

  function accApprovalsEmptyStateHtml(kind, msg) {
    if (kind === 'loading') {
      return (
        '<div class="col-span-full acc-approvals-empty text-slate-400">' +
        '<i class="fas fa-spinner fa-spin text-3xl text-indigo-400" aria-hidden="true"></i>' +
        '<span class="text-sm font-medium">جاري التحميل...</span></div>'
      );
    }
    if (kind === 'error') {
      return (
        '<div class="col-span-full acc-approvals-empty text-slate-600">' +
        '<i class="fas fa-circle-exclamation text-4xl text-red-400" aria-hidden="true"></i>' +
        '<p class="text-red-600 font-medium text-sm">' + escHtml(msg || 'حدث خطأ') + '</p></div>'
      );
    }
    return (
      '<div class="col-span-full acc-approvals-empty text-slate-500">' +
      '<span class="inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-slate-100 text-slate-300">' +
      '<i class="fas fa-clipboard-list text-4xl" aria-hidden="true"></i></span>' +
      '<p class="font-medium text-slate-600">لا يوجد معتمدون</p>' +
      '<p class="text-xs text-slate-400 max-w-sm leading-relaxed">أضف معتمداً من زر «إضافة معتمد» أو استورد أرصدة من «رفع أرصدة».</p></div>'
    );
  }

  window.accLoad = function() {
    var box = document.getElementById('accCards');
    if (!box) return;
    box.innerHTML = accApprovalsEmptyStateHtml('loading');
    apiCall('/api/accreditations/list').then(function(res) {
      if (!res.success) {
        box.innerHTML = accApprovalsEmptyStateHtml('error', res.message || '');
        return;
      }
      var list = res.list || [];
      if (list.length === 0) {
        box.innerHTML = accApprovalsEmptyStateHtml('empty');
        return;
      }
      box.innerHTML = list.map(function(a) {
        var pin = a.pinned ? '<i class="fas fa-thumbtack text-amber-500 ml-1"></i>' : '';
        return '<div class="rounded-2xl border border-slate-200/80 bg-slate-50/50 hover:bg-white p-5 shadow-sm cursor-pointer hover:shadow-md hover:border-indigo-200/80 transition-colors" onclick="accOpen(' + a.id + ')">' +
          pin + '<h5 class="font-bold text-slate-900">' + escHtml(a.name || '') + '</h5>' +
          '<p class="text-xs text-slate-500">' + escHtml(a.code || '') + '</p>' +
          '<p class="text-indigo-600 font-semibold mt-2 tabular-nums">' + (a.balance_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</p></div>';
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

  function accSyncBulkSourcePanels() {
    var sel = document.getElementById('accBulkSourceMethod');
    var v = sel && sel.value ? sel.value : 'file';
    var panels = {
      file: document.getElementById('accBulkPanelFile'),
      paste: document.getElementById('accBulkPanelPaste'),
      sheet: document.getElementById('accBulkPanelSheet'),
    };
    Object.keys(panels).forEach(function(k) {
      var el = panels[k];
      if (!el) return;
      el.classList.toggle('hidden', k !== v);
    });
  }
  window.accSyncBulkSourcePanels = accSyncBulkSourcePanels;

  function wireAccBulkSourceMethod() {
    var sel = document.getElementById('accBulkSourceMethod');
    if (!sel || sel.dataset.accBulkMethodBound) return;
    sel.dataset.accBulkMethodBound = '1';
    sel.addEventListener('change', accSyncBulkSourcePanels);
  }

  function accBulkClearFileNameDisplay() {
    var el = document.getElementById('accBulkFileName');
    if (el) {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function accBulkUpdateFileNameDisplay() {
    var input = document.getElementById('accBulkFile');
    var el = document.getElementById('accBulkFileName');
    if (!el || !input) return;
    if (input.files && input.files[0]) {
      el.textContent = input.files[0].name;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function wireAccBulkDropzone() {
    var dz = document.getElementById('accBulkDropzone');
    var input = document.getElementById('accBulkFile');
    if (!dz || !input || dz.dataset.accBulkDzBound) return;
    dz.dataset.accBulkDzBound = '1';
    input.addEventListener('change', accBulkUpdateFileNameDisplay);
    ['dragenter', 'dragover'].forEach(function(ev) {
      dz.addEventListener(ev, function(e) {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('acc-bulk-dropzone-drag');
      });
    });
    dz.addEventListener('dragleave', function(e) {
      if (e.relatedTarget && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('acc-bulk-dropzone-drag');
    });
    dz.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('acc-bulk-dropzone-drag');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      try {
        var dt = new DataTransfer();
        dt.items.add(files[0]);
        input.files = dt.files;
      } catch (err) {}
      accBulkUpdateFileNameDisplay();
    });
  }

  window.accOpenBulk = function() {
    accClearBulkStaging();
    accBulkClearFileNameDisplay();
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
    var method = document.getElementById('accBulkSourceMethod');
    if (method) method.value = 'file';
    accSyncBulkSourcePanels();
    accSyncBulkStep();
    var modal = document.getElementById('accBulkModal');
    var body = document.getElementById('accBulkModalBody');
    if (body) body.scrollTop = 0;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };
  window.accCloseBulk = function() {
    var modal = document.getElementById('accBulkModal');
    var body = document.getElementById('accBulkModalBody');
    if (body) body.scrollTop = 0;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
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
    wireAccBulkStagingDelegation();
    wireAccBulkSourceMethod();
    wireAccBulkDropzone();
    accSyncBulkSourcePanels();
    accLoad();
    accAmountKindChange();
  });
})();
