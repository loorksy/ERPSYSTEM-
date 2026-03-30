(function() {
  'use strict';

  let currentAgencyId = null;

  function showToast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else alert(msg);
  }

  function apiCall(url, opts) {
    if (typeof window.apiCall === 'function') return window.apiCall(url, opts);
    return fetch(url, { credentials: 'same-origin', ...opts }).then(r => r.json());
  }

  var agencyCardBarColors = [
    'bg-indigo-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-violet-500',
    'bg-sky-500',
    'bg-orange-500',
    'bg-teal-500'
  ];

  function escapeHtml(s) {
    if (s == null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadAgencies() {
    const container = document.getElementById('subAgenciesCards');
    if (!container) return;
    container.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">جاري التحميل...</p>';
    apiCall('/api/sub-agencies/list').then(function(res) {
      if (!res.success) {
        container.innerHTML = '<p class="text-red-500 col-span-full text-center py-12">' + (res.message || 'فشل التحميل') + '</p>';
        return;
      }
      const list = res.agencies || [];
      if (list.length === 0) {
        container.innerHTML = '<p class="text-slate-400 col-span-full text-center py-12">لا توجد وكالات. أضف وكالة جديدة.</p>';
        return;
      }
      container.innerHTML = list.map(function(a, i) {
        const bal = a.balance || 0;
        const balLabel = bal >= 0 ? 'دائن' : 'مديون';
        const bar = agencyCardBarColors[i % agencyCardBarColors.length];
        const textColor = bal >= 0 ? '#047857' : '#b91c1c';
        const balStr = window.formatMoney ? window.formatMoney(bal) : bal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
        const name = escapeHtml(a.name || '');
        return '<div class="sub-agency-list-card group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg" onclick="window.location.href=\'/sub-agencies/' + a.id + '\'">' +
          '<div class="' + bar + ' h-1 w-full"></div>' +
          '<div class="p-4">' +
          '<div class="flex items-start justify-between gap-3">' +
          '<h5 class="min-w-0 flex-1 text-base font-bold leading-snug text-slate-900 sm:text-[1.05rem]">' + name + '</h5>' +
          '<button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]" ' +
          'onclick="event.stopPropagation(); subAgenciesDownloadPdf(' + a.id + ')" title="تنزيل PDF"><i class="fas fa-file-pdf text-red-500"></i></button>' +
          '</div>' +
          '<dl class="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:text-xs">' +
          '<div class="rounded-lg border border-slate-100 bg-slate-50/90 px-2.5 py-2"><dt class="text-slate-500">حصة الشركة من الو</dt><dd class="mt-0.5 font-bold tabular-nums text-slate-800">' + (a.company_percent != null ? a.company_percent : '—') + '%</dd></div>' +
          '<div class="rounded-lg border border-slate-100 bg-slate-50/90 px-2.5 py-2"><dt class="text-slate-500">حصة الوكالة</dt><dd class="mt-0.5 font-bold tabular-nums text-slate-800">' + (a.commission_percent != null ? a.commission_percent : '—') + '%</dd></div>' +
          '</dl>' +
          '<div class="mt-3 flex flex-wrap items-end justify-between gap-2 rounded-xl border border-slate-100 bg-gradient-to-l from-slate-50 to-white px-3 py-2.5">' +
          '<span class="text-xs font-semibold text-slate-500">الرصيد</span>' +
          '<span class="text-lg font-bold tabular-nums" style="color:' + textColor + '">' + balStr + ' <span class="text-[11px] font-semibold opacity-85">(' + balLabel + ')</span></span>' +
          '</div>' +
          '<div class="agency-card-shortcuts mt-3 flex gap-2 border-t border-slate-100 pt-3" onclick="event.stopPropagation()">' +
          '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white shadow-md shadow-emerald-600/20 transition hover:bg-emerald-700 active:scale-[0.99] sm:text-xs" ' +
          'onclick="subAgenciesOpenRewardModalFor(' + a.id + ')"><i class="fas fa-gift text-[0.7rem]"></i>مكافأة</button>' +
          '<button type="button" class="inline-flex min-h-[2.35rem] flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-900 shadow-sm transition hover:bg-rose-100 active:scale-[0.99] sm:text-xs" ' +
          'onclick="subAgenciesOpenDeductModalFor(' + a.id + ')"><i class="fas fa-minus-circle text-[0.7rem]"></i>خصم</button>' +
          '</div>' +
          '</div>' +
          '</div>';
      }).join('');
    });
  }

  window.subAgenciesDownloadPdf = function(agencyId) {
    var cs = document.getElementById('subAgencyCycleSelect');
    var cycleId = cs && cs.value ? cs.value : '';
    var q = 'subAgencyId=' + encodeURIComponent(agencyId) + (cycleId ? '&cycleId=' + encodeURIComponent(cycleId) : '');
    window.open('/api/reports/pdf/sub-agency?' + q, '_blank');
  };

  window.subAgenciesDownloadPdfCurrent = function() {
    if (!currentAgencyId) return;
    subAgenciesDownloadPdf(currentAgencyId);
  };

  window.subAgenciesOpenAddModal = function() {
    document.getElementById('subAgencyAddForm').reset();
    document.getElementById('subAgencyAddModal').classList.remove('hidden');
    document.getElementById('subAgencyAddModal').classList.add('flex');
  };

  window.subAgenciesCloseAddModal = function() {
    document.getElementById('subAgencyAddModal').classList.add('hidden');
    document.getElementById('subAgencyAddModal').classList.remove('flex');
  };

  window.subAgenciesOpenDashboard = function(id) {
    window.location.href = '/sub-agencies/' + id;
  };

  window.subAgenciesBackToList = function() {
    window.location.href = '/sub-agencies';
  };

  window.subAgenciesLoadCycles = function() {
    apiCall('/api/sub-agencies/cycles/list').then(function(res) {
      const sel = document.getElementById('subAgencyCycleSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر الدورة --</option>';
      (res.cycles || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || '') + '</option>';
      });
      var list = res.cycles || [];
      if (list[0] && list[0].id) sel.value = String(list[0].id);
    });
  };

  window.subAgenciesLoadDashboard = function() {
    if (!currentAgencyId) return;
    apiCall('/api/sub-agencies/' + currentAgencyId).then(function(res) {
      if (!res.success) return;
      const a = res.agency;
      var titleEl = document.getElementById('subAgencyDashboardTitle');
      if (titleEl) titleEl.textContent = a.name || 'لوحة الوكالة';
      var balVal = document.getElementById('subAgencyBalanceValue');
      var balStatus = document.getElementById('subAgencyBalanceStatus');
      if (balVal && a) {
        var bal = a.balance != null ? a.balance : 0;
        balVal.textContent = window.formatMoney ? window.formatMoney(bal) : bal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' $';
      }
      if (balStatus && a) {
        var b = a.balance != null ? a.balance : 0;
        balStatus.textContent = b >= 0 ? 'دائن' : 'مديون';
        balStatus.className = 'rounded-lg px-2 py-0.5 text-[11px] font-bold sm:text-xs ' +
          (b >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800');
      }
    });
    const cycleId = document.getElementById('subAgencyCycleSelect').value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/profit' + (cycleId ? '?cycleId=' + cycleId : '')).then(function(res) {
      if (res.success) {
        const el = document.getElementById('subAgencyProfit');
        if (el) el.textContent = (window.formatMoney ? window.formatMoney(res.profit || 0) : (res.profit || 0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $');
        const inp = document.getElementById('subAgencyPercentInput');
        if (inp) {
          if (cycleId && res.cycleCompanyPercent != null && res.cycleCompanyPercent !== undefined) {
            inp.value = res.cycleCompanyPercent;
          } else if (cycleId && res.cycleCommissionPercent != null && res.cycleCommissionPercent !== undefined) {
            inp.value = res.cycleCommissionPercent;
          } else {
            inp.value = res.companyPercent != null ? res.companyPercent : 0;
          }
        }
      }
    });
    apiCall('/api/sub-agencies/' + currentAgencyId + '/users').then(function(res) {
      const el = document.getElementById('subAgencyUsersCount');
      if (el) el.textContent = (res.users || []).length;
    });
    subAgenciesLoadTransactions();
  };

  window.subAgenciesUpdatePercent = function() {
    if (!currentAgencyId) return;
    const inp = document.getElementById('subAgencyPercentInput');
    const val = inp.value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/update-percent', {
      method: 'POST',
      body: JSON.stringify({ commissionPercent: val })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
    });
  };

  window.subAgenciesSaveCyclePercent = function() {
    if (!currentAgencyId) return;
    const cycleId = document.getElementById('subAgencyCycleSelect').value;
    if (!cycleId) {
      showToast('اختر الدورة المالية أولاً', 'error');
      return;
    }
    const val = document.getElementById('subAgencyPercentInput').value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/cycle-percent', {
      method: 'POST',
      body: JSON.stringify({ cycleId, commissionPercent: val })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) subAgenciesLoadDashboard();
    });
  };

  window.subAgenciesOpenRewardModalFor = function(agencyId) {
    currentAgencyId = parseInt(agencyId, 10);
    if (isNaN(currentAgencyId)) return;
    subAgenciesOpenRewardModal();
  };

  window.subAgenciesOpenDeductModalFor = function(agencyId) {
    currentAgencyId = parseInt(agencyId, 10);
    if (isNaN(currentAgencyId)) return;
    subAgenciesOpenDeductModal();
  };

  function clearSubAgencyContextIfListOnly() {
    if (!document.getElementById('subAgencyDashboardPage')) {
      currentAgencyId = null;
    }
  }

  window.subAgenciesOpenRewardModal = function() {
    document.getElementById('subAgencyRewardForm').reset();
    var hint = document.getElementById('subAgencyRewardBalanceHint');
    var cb = document.getElementById('subAgencyRewardDeductFromFund');
    if (!currentAgencyId) {
      if (hint) { hint.classList.add('hidden'); hint.textContent = ''; }
      if (cb) cb.checked = true;
    } else {
      apiCall('/api/sub-agencies/' + currentAgencyId).then(function(res) {
        if (!res.success || !res.agency) {
          if (hint) hint.classList.add('hidden');
          if (cb) cb.checked = true;
          return;
        }
        var bal = res.agency.balance != null ? res.agency.balance : 0;
        var owesUs = bal < 0;
        if (cb) cb.checked = !owesUs;
        if (hint) {
          hint.classList.remove('hidden');
          if (owesUs) {
            hint.className = 'rounded-xl border border-indigo-100 bg-indigo-50/90 p-3 text-sm leading-relaxed text-indigo-950';
            hint.innerHTML = 'رصيد الوكالة <strong>مديون</strong> لنا (رصيد سالب). يُفضَّل عدم خصم من الصندوق: تُسجَّل المكافأة كائتمان محاسبي فقط. يمكنك تفعيل الخصم من الصندوق يدوياً إذا دفعت نقداً.';
          } else {
            hint.className = 'rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-700';
            hint.innerHTML = 'رصيد الوكالة <strong>دائن</strong> أو متعادل. يُخصم من الصندوق افتراضياً إذا بقي الخيار مفعّلاً.';
          }
        }
      });
    }
    document.getElementById('subAgencyRewardModal').classList.remove('hidden');
    document.getElementById('subAgencyRewardModal').classList.add('flex');
  };

  window.subAgenciesCloseRewardModal = function() {
    document.getElementById('subAgencyRewardModal').classList.add('hidden');
    document.getElementById('subAgencyRewardModal').classList.remove('flex');
    clearSubAgencyContextIfListOnly();
  };

  window.subAgenciesOpenDeductModal = function() {
    if (!currentAgencyId) {
      showToast('افتح لوحة وكالة أولاً', 'error');
      return;
    }
    var kindEl = document.getElementById('subAgencyDeductKind');
    if (kindEl) kindEl.value = 'shipping';
    subAgenciesDeductKindChange();
    document.getElementById('subAgencyDeductModal').classList.remove('hidden');
    document.getElementById('subAgencyDeductModal').classList.add('flex');
  };

  window.subAgenciesCloseDeductModal = function() {
    document.getElementById('subAgencyDeductModal').classList.add('hidden');
    document.getElementById('subAgencyDeductModal').classList.remove('flex');
    clearSubAgencyContextIfListOnly();
  };

  window.subAgenciesDeductKindChange = function() {
    var k = document.getElementById('subAgencyDeductKind');
    var kind = k ? k.value : 'shipping';
    var sal = document.getElementById('subAgencyDeductSalaryFields');
    var shipHint = document.getElementById('subAgencyDeductShipHint');
    var btn = document.getElementById('subAgencyDeductSubmit');
    if (kind === 'salary') {
      if (sal) sal.classList.remove('hidden');
      if (shipHint) shipHint.classList.add('hidden');
      if (btn) btn.textContent = 'تنفيذ';
    } else {
      if (sal) sal.classList.add('hidden');
      if (shipHint) shipHint.classList.remove('hidden');
      if (btn) btn.textContent = 'فتح الشحن';
    }
  };

  window.subAgenciesShowUsers = function() {
    if (!currentAgencyId) return;
    document.getElementById('subAgencyUsersModal').classList.remove('hidden');
    document.getElementById('subAgencyUsersModal').classList.add('flex');
    const listEl = document.getElementById('subAgencyUsersList');
    listEl.innerHTML = '<p class="text-slate-400 text-center py-4">جاري التحميل...</p>';
    apiCall('/api/sub-agencies/' + currentAgencyId + '/users').then(function(res) {
      const users = res.users || [];
      if (users.length === 0) {
        listEl.innerHTML = '<p class="text-slate-400 text-center py-4">لا يوجد مستخدمين مسجلين</p>';
      } else {
        listEl.innerHTML = users.map(function(u) {
          return '<div class="py-2 px-3 rounded-lg bg-slate-50 mb-2">' + (u.name || u.id) + '</div>';
        }).join('');
      }
    });
  };

  window.subAgenciesCloseUsersModal = function() {
    document.getElementById('subAgencyUsersModal').classList.add('hidden');
    document.getElementById('subAgencyUsersModal').classList.remove('flex');
  };

  window.subAgenciesLoadTransactions = function() {
    if (!currentAgencyId) return;
    const listEl = document.getElementById('subAgencyTxList');
    listEl.innerHTML = '<p class="text-slate-400 text-center py-10 text-sm">جاري التحميل...</p>';
    const params = new URLSearchParams();
    const type = document.getElementById('subAgencyTxTypeFilter').value;
    const from = document.getElementById('subAgencyTxFrom').value;
    const to = document.getElementById('subAgencyTxTo').value;
    if (type) params.set('type', type);
    if (from) params.set('fromDate', from);
    if (to) params.set('toDate', to);
    apiCall('/api/sub-agencies/' + currentAgencyId + '/transactions?' + params.toString()).then(function(res) {
      if (!res.success) {
        listEl.innerHTML = '<p class="text-red-500 text-center py-10 text-sm">' + (res.message || 'فشل') + '</p>';
        return;
      }
      const rows = res.transactions || [];
      if (rows.length === 0) {
        listEl.innerHTML = '<p class="text-slate-400 text-center py-10 text-sm">لا توجد معاملات</p>';
        return;
      }
      listEl.innerHTML = rows.map(function(r) {
        const isPlus = r.type === 'profit' || r.type === 'reward';
        const cls = isPlus ? 'text-emerald-700' : 'text-red-700';
        const sign = isPlus ? '+' : '-';
        const date = r.created_at ? new Date(r.created_at).toLocaleDateString('ar-SA') : '-';
        return '<div class="flex flex-col gap-1 border-b border-slate-100/90 bg-white px-3 py-3 last:border-b-0 hover:bg-slate-50/80 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-4">' +
          '<div class="min-w-0 flex-1 text-sm leading-relaxed"><span class="font-semibold ' + cls + '">' + (r.typeLabel || r.type) + '</span> ' + sign + (window.formatMoney ? window.formatMoney(r.amount || 0) : (r.amount || 0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $') + (r.notes ? ' <span class="text-slate-500 break-words">- ' + r.notes + '</span>' : '') + '</div>' +
          '<div class="shrink-0 text-[11px] tabular-nums text-slate-400 sm:text-xs sm:text-end">' + date + '</div>' +
          '</div>';
      }).join('');
    });
  };

  document.getElementById('subAgencyAddForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    const name = document.getElementById('subAgencyAddName').value.trim();
    const percent = document.getElementById('subAgencyAddPercent').value;
    apiCall('/api/sub-agencies/add', {
      method: 'POST',
      body: JSON.stringify({ name, commissionPercent: percent })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        subAgenciesCloseAddModal();
        loadAgencies();
      }
    });
  });

  document.getElementById('subAgencyDeductForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    if (!currentAgencyId) return;
    var kindEl = document.getElementById('subAgencyDeductKind');
    var kind = kindEl ? kindEl.value : 'shipping';
    if (kind === 'shipping') {
      apiCall('/api/sub-agencies/' + currentAgencyId + '/deduct', {
        method: 'POST',
        body: JSON.stringify({ kind: 'shipping' })
      }).then(function(res) {
        if (res.redirect) {
          subAgenciesCloseDeductModal();
          window.location.href = res.redirect;
          return;
        }
        showToast(res.message || '', res.success ? 'success' : 'error');
      });
      return;
    }
    var amt = document.getElementById('subAgencyDeductAmount').value;
    var payrollMode = document.getElementById('subAgencyDeductPayrollMode').value;
    var notes = document.getElementById('subAgencyDeductNotes').value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/deduct', {
      method: 'POST',
      body: JSON.stringify({ kind: 'salary', amount: amt, payrollMode: payrollMode, notes: notes })
    }).then(function(res) {
      showToast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        subAgenciesCloseDeductModal();
        if (document.getElementById('subAgenciesCards')) {
          loadAgencies();
        } else {
          subAgenciesLoadDashboard();
          subAgenciesLoadTransactions();
        }
      }
    });
  });

  document.getElementById('subAgencyRewardForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    if (!currentAgencyId) return;
    const amount = document.getElementById('subAgencyRewardAmount').value;
    const notes = document.getElementById('subAgencyRewardNotes').value;
    const deductFromFund = document.getElementById('subAgencyRewardDeductFromFund') && document.getElementById('subAgencyRewardDeductFromFund').checked;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/reward', {
      method: 'POST',
      body: JSON.stringify({ amount, notes, deductFromFund })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        subAgenciesCloseRewardModal();
        if (document.getElementById('subAgenciesCards')) {
          loadAgencies();
        } else {
          subAgenciesLoadDashboard();
        }
      }
    });
  });

  window.subAgenciesOpenDeliveryModal = function() {
    var m = document.getElementById('subAgencyDeliveryModal');
    if (!m) return;
    m.classList.remove('hidden');
    apiCall('/api/sub-agencies/cycles/list').then(function(res) {
      var sel = document.getElementById('saDeliveryCycle');
      if (!sel) return;
      sel.innerHTML = '<option value="">— اختر —</option>';
      (res.cycles || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || c.id) + '</option>';
      });
    });
    apiCall('/api/sub-agencies/list').then(function(res) {
      var box = document.getElementById('saDeliveryChecks');
      if (!box || !res.success) return;
      box.innerHTML = (res.agencies || []).map(function(a) {
        return '<label class="flex items-center gap-2 py-1"><input type="checkbox" class="sa-del-cb" value="' + a.id + '"> ' + (a.name || '') + ' — رصيد: ' + (a.balance || 0) + '</label>';
      }).join('');
    });
  };
  window.subAgenciesCloseDeliveryModal = function() {
    var m = document.getElementById('subAgencyDeliveryModal');
    if (m) m.classList.add('hidden');
  };
  window.subAgenciesSubmitDelivery = function() {
    var cids = [];
    document.querySelectorAll('.sa-del-cb:checked').forEach(function(cb) { cids.push(parseInt(cb.value, 10)); });
    var cycleId = document.getElementById('saDeliveryCycle') && document.getElementById('saDeliveryCycle').value;
    apiCall('/api/sub-agencies/delivery-settle', {
      method: 'POST',
      body: JSON.stringify({ cycleId: cycleId || null, subAgencyIds: cids })
    }).then(function(res) {
      showToast(res.message || '', res.success ? 'success' : 'error');
      if (res.success) {
        subAgenciesCloseDeliveryModal();
        loadAgencies();
      }
    });
  };

  function fillSubAgencySyncCycleSelect() {
    var sel = document.getElementById('subAgencySyncCycleSelect');
    if (!sel) return;
    apiCall('/api/sub-agencies/cycles/list').then(function(res) {
      sel.innerHTML = '<option value="">— اختر الدورة —</option>';
      (res.cycles || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || c.id) + '</option>';
      });
      var list = res.cycles || [];
      if (list[0] && list[0].id) sel.value = String(list[0].id);
    });
  }

  window.subAgenciesRunManagementSync = function() {
    var sel = document.getElementById('subAgencySyncCycleSelect');
    var cycleId = sel && sel.value ? sel.value : '';
    if (!cycleId) {
      showToast('اختر الدورة المالية أولاً', 'error');
      return;
    }
    apiCall('/api/sub-agencies/sync-from-management', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cycleId: parseInt(cycleId, 10) })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) loadAgencies();
    });
  };

  var subAgencyNavIds = [];
  var subAgencyNavIndex = -1;

  function subAgencyNavUpdateState() {
    var prevBtn = document.getElementById('subAgencyNavPrev');
    var nextBtn = document.getElementById('subAgencyNavNext');
    if (!prevBtn || !nextBtn) return;
    var hasPrev = subAgencyNavIndex > 0;
    var hasNext = subAgencyNavIndex >= 0 && subAgencyNavIndex < subAgencyNavIds.length - 1;
    prevBtn.disabled = !hasPrev;
    nextBtn.disabled = !hasNext;
  }

  function subAgencyNavGo(delta) {
    if (subAgencyNavIndex < 0 || !subAgencyNavIds.length) return;
    var n = subAgencyNavIndex + delta;
    if (n < 0 || n >= subAgencyNavIds.length) return;
    window.location.href = '/sub-agencies/' + subAgencyNavIds[n];
  }

  function initSubAgencyProfileNav() {
    var dash = document.getElementById('subAgencyDashboardPage');
    if (!dash || !dash.dataset.agencyId) return;
    var zone = document.querySelector('.sub-agency-detail-page');
    var prevBtn = document.getElementById('subAgencyNavPrev');
    var nextBtn = document.getElementById('subAgencyNavNext');
    if (!zone || !prevBtn || !nextBtn) return;

    var cur = parseInt(dash.dataset.agencyId, 10);
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    apiCall('/api/sub-agencies/list').then(function(res) {
      if (!res.success || !res.agencies || !res.agencies.length) return;
      subAgencyNavIds = res.agencies.map(function(a) { return a.id; });
      subAgencyNavIndex = subAgencyNavIds.indexOf(cur);
      subAgencyNavUpdateState();
    });

    prevBtn.addEventListener('click', function() { subAgencyNavGo(-1); });
    nextBtn.addEventListener('click', function() { subAgencyNavGo(1); });

    var touchStartX = 0;
    var touchStartY = 0;
    var touchDeny = false;

    zone.addEventListener('touchstart', function(e) {
      if (window.innerWidth >= 1024) return;
      var el = e.target;
      if (el.closest && el.closest('input, textarea, select, button, a, label, .sub-agency-tx-list')) {
        touchDeny = true;
        return;
      }
      touchDeny = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    zone.addEventListener('touchend', function(e) {
      if (window.innerWidth >= 1024) return;
      if (touchDeny) return;
      if (!e.changedTouches || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx > 0) subAgencyNavGo(-1);
      else subAgencyNavGo(1);
    }, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', function() {
    var dash = document.getElementById('subAgencyDashboardPage');
    if (dash && dash.dataset.agencyId) {
      currentAgencyId = parseInt(dash.dataset.agencyId, 10);
      subAgenciesLoadCycles();
      var cs = document.getElementById('subAgencyCycleSelect');
      if (cs) cs.addEventListener('change', subAgenciesLoadDashboard);
      subAgenciesLoadDashboard();
      initSubAgencyProfileNav();
      return;
    }
    fillSubAgencySyncCycleSelect();
    loadAgencies();
  });
})();
