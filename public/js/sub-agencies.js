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
        return '<div class="agency-card" style="background:' + color + '; color:#1e293b;" onclick="subAgenciesOpenDashboard(' + a.id + ')">' +
          '<h5>' + (a.name || '') + '</h5>' +
          '<p class="agency-meta">نسبة الوكالة: ' + (a.commission_percent || 0) + '%</p>' +
          '<p class="agency-balance" style="color:' + textColor + '">رصيد: ' + bal.toLocaleString('ar-SA') + ' (' + balLabel + ')</p>' +
          '</div>';
      }).join('');
    });
  }

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
    currentAgencyId = id;
    document.getElementById('subAgenciesList').classList.add('hidden');
    document.getElementById('subAgencyDashboard').classList.remove('hidden');
    subAgenciesLoadCycles();
    subAgenciesLoadDashboard();
  };

  window.subAgenciesBackToList = function() {
    currentAgencyId = null;
    document.getElementById('subAgencyDashboard').classList.add('hidden');
    document.getElementById('subAgenciesList').classList.remove('hidden');
    loadAgencies();
  };

  window.subAgenciesLoadCycles = function() {
    apiCall('/api/sub-agencies/cycles/list').then(function(res) {
      const sel = document.getElementById('subAgencyCycleSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- اختر الدورة --</option>';
      (res.cycles || []).forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + (c.name || '') + '</option>';
      });
    });
  };

  window.subAgenciesLoadDashboard = function() {
    if (!currentAgencyId) return;
    apiCall('/api/sub-agencies/' + currentAgencyId).then(function(res) {
      if (!res.success) return;
      const a = res.agency;
      document.getElementById('subAgencyDashboardTitle').textContent = a.name || 'لوحة الوكالة';
      document.getElementById('subAgencyPercentInput').value = a.commission_percent || 0;
    });
    const cycleId = document.getElementById('subAgencyCycleSelect').value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/profit' + (cycleId ? '?cycleId=' + cycleId : '')).then(function(res) {
      if (res.success) {
        const el = document.getElementById('subAgencyProfit');
        if (el) el.textContent = (res.profit || 0).toLocaleString('ar-SA');
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

  window.subAgenciesOpenRewardModal = function() {
    document.getElementById('subAgencyRewardForm').reset();
    document.getElementById('subAgencyRewardModal').classList.remove('hidden');
    document.getElementById('subAgencyRewardModal').classList.add('flex');
  };

  window.subAgenciesCloseRewardModal = function() {
    document.getElementById('subAgencyRewardModal').classList.add('hidden');
    document.getElementById('subAgencyRewardModal').classList.remove('flex');
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
          '<div class="flex-1 min-w-0"><span class="font-semibold" style="' + cls + '">' + (r.typeLabel || r.type) + '</span> ' + sign + (r.amount || 0).toLocaleString('ar-SA') + (r.notes ? ' <span class="text-slate-500 text-sm">- ' + r.notes + '</span>' : '') + '</div>' +
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

  document.getElementById('subAgencyRewardForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    if (!currentAgencyId) return;
    const amount = document.getElementById('subAgencyRewardAmount').value;
    const notes = document.getElementById('subAgencyRewardNotes').value;
    apiCall('/api/sub-agencies/' + currentAgencyId + '/reward', {
      method: 'POST',
      body: JSON.stringify({ amount, notes })
    }).then(function(res) {
      showToast(res.message || (res.success ? 'تم' : 'فشل'), res.success ? 'success' : 'error');
      if (res.success) {
        subAgenciesCloseRewardModal();
        subAgenciesLoadDashboard();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', function() {
    loadAgencies();
  });
})();
