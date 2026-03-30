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

  var agencyCardColors = [
    'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 50%, #a5b4fc 100%)',
    'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 50%, #6ee7b7 100%)',
    'linear-gradient(135deg, #fef3c7 0%, #fde68a 50%, #fcd34d 100%)',
    'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 50%, #f9a8d4 100%)',
    'linear-gradient(135deg, #cffafe 0%, #a5f3fc 50%, #67e8f9 100%)',
    'linear-gradient(135deg, #ede9fe 0%, #ddd6fe 50%, #c4b5fd 100%)',
    'linear-gradient(135deg, #fed7aa 0%, #fdba74 50%, #fb923c 100%)',
    'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 50%, #93c5fd 100%)'
  ];

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
        const color = agencyCardColors[i % agencyCardColors.length];
        const textColor = bal >= 0 ? '#047857' : '#b91c1c';
        return '<div class="agency-card relative cursor-pointer" style="background:' + color + '; color:#1e293b;" onclick="window.location.href=\'/sub-agencies/' + a.id + '\'">' +
          '<button type="button" class="absolute top-2 right-2 z-10 px-2 py-1 rounded-lg bg-white/90 text-slate-700 text-xs font-bold shadow border border-slate-200 hover:bg-white" ' +
          'onclick="event.stopPropagation(); subAgenciesDownloadPdf(' + a.id + ')" title="تنزيل PDF"><i class="fas fa-file-pdf text-red-600"></i></button>' +
          '<h5>' + (a.name || '') + '</h5>' +
          '<p class="agency-meta">حصة الشركة من الو: ' + (a.company_percent != null ? a.company_percent : '—') + '% — حصة الوكالة: ' + (a.commission_percent != null ? a.commission_percent : '—') + '%</p>' +
          '<p class="agency-balance" style="color:' + textColor + '">رصيد: ' + (window.formatMoney ? window.formatMoney(bal) : bal.toLocaleString('en-US',{minimumFractionDigits:2}) + ' $') + ' (' + balLabel + ')</p>' +
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
      document.getElementById('subAgencyDashboardTitle').textContent = a.name || 'لوحة الوكالة';
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
            hint.className = 'text-sm rounded-lg p-3 mb-3 bg-indigo-50 text-indigo-900 border border-indigo-100';
            hint.innerHTML = 'رصيد الوكالة <strong>مديون</strong> لنا (رصيد سالب). يُفضَّل عدم خصم من الصندوق: تُسجَّل المكافأة كائتمان محاسبي فقط. يمكنك تفعيل الخصم من الصندوق يدوياً إذا دفعت نقداً.';
          } else {
            hint.className = 'text-sm rounded-lg p-3 mb-3 bg-slate-50 text-slate-600 border border-slate-100';
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
    listEl.innerHTML = '<p class="text-slate-400 text-center py-4">جاري التحميل...</p>';
    const params = new URLSearchParams();
    const type = document.getElementById('subAgencyTxTypeFilter').value;
    const from = document.getElementById('subAgencyTxFrom').value;
    const to = document.getElementById('subAgencyTxTo').value;
    if (type) params.set('type', type);
    if (from) params.set('fromDate', from);
    if (to) params.set('toDate', to);
    apiCall('/api/sub-agencies/' + currentAgencyId + '/transactions?' + params.toString()).then(function(res) {
      if (!res.success) {
        listEl.innerHTML = '<p class="text-red-500 text-center py-4">' + (res.message || 'فشل') + '</p>';
        return;
      }
      const rows = res.transactions || [];
      if (rows.length === 0) {
        listEl.innerHTML = '<p class="text-slate-400 text-center py-4">لا توجد معاملات</p>';
        return;
      }
      listEl.innerHTML = rows.map(function(r) {
        const isPlus = r.type === 'profit' || r.type === 'reward';
        const cls = isPlus ? 'color:#047857' : 'color:#b91c1c';
        const sign = isPlus ? '+' : '-';
        const date = r.created_at ? new Date(r.created_at).toLocaleDateString('ar-SA') : '-';
        return '<div class="tx-item">' +
          '<div class="flex-1 min-w-0"><span class="font-semibold" style="' + cls + '">' + (r.typeLabel || r.type) + '</span> ' + sign + (window.formatMoney ? window.formatMoney(r.amount || 0) : (r.amount || 0).toLocaleString('en-US',{minimumFractionDigits:2}) + ' $') + (r.notes ? ' <span class="text-slate-500 text-sm">- ' + r.notes + '</span>' : '') + '</div>' +
          '<div class="text-xs text-slate-400">' + date + '</div>' +
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
        subAgenciesLoadDashboard();
        subAgenciesLoadTransactions();
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
        subAgenciesLoadDashboard();
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

  document.addEventListener('DOMContentLoaded', function() {
    var dash = document.getElementById('subAgencyDashboardPage');
    if (dash && dash.dataset.agencyId) {
      currentAgencyId = parseInt(dash.dataset.agencyId, 10);
      subAgenciesLoadCycles();
      var cs = document.getElementById('subAgencyCycleSelect');
      if (cs) cs.addEventListener('change', subAgenciesLoadDashboard);
      subAgenciesLoadDashboard();
      return;
    }
    fillSubAgencySyncCycleSelect();
    loadAgencies();
  });
})();
