(function () {
  if (typeof Handsontable === 'undefined') {
    console.error('Handsontable not loaded');
    return;
  }

  const COLS = (function () {
    const o = [];
    for (let i = 0; i < 26; i++) o.push(String.fromCharCode(65 + i));
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        o.push(String.fromCharCode(65 + i) + String.fromCharCode(65 + j));
      }
    }
    return o;
  })();

  const state = {
    cycleId: null,
    mainTab: 'management',
    sheetIndex: { management: 0, agent: 0, userInfo: 0 },
    workbooks: {
      management: { sheets: [{ name: 'ورقة1', rows: [['']] }] },
      agent: { sheets: [{ name: 'ورقة1', rows: [['']] }] },
      userInfo: { sheets: [{ name: 'ورقة1', rows: [['']] }] },
    },
    settings: {},
    hot: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function showToast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else alert(msg);
  }

  function fillColSelects() {
    document.querySelectorAll('.pn-col-select').forEach(function (sel) {
      if (sel.options.length) return;
      COLS.forEach(function (c) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      });
    });
  }

  function setSelectValue(id, val) {
    const el = $(id);
    if (!el) return;
    el.value = val || el.options[0].value;
  }

  function destroyHot() {
    if (state.hot) {
      try {
        state.hot.destroy();
      } catch (_) {}
      state.hot = null;
    }
    const c = $('pnHotContainer');
    if (c) c.innerHTML = '';
  }

  function hotDataToRows(hot) {
    const d = hot.getData();
    return d.map(function (row) {
      return row.map(function (cell) {
        if (cell === null || cell === undefined) return '';
        return cell;
      });
    });
  }

  function ensureMinRows(rows) {
    if (!rows.length) return [['']];
    return rows;
  }

  function renderHot() {
    destroyHot();
    const kind = state.mainTab;
    let sheets = state.workbooks[kind].sheets;
    if (!sheets.length) {
      sheets.push({ name: 'ورقة1', rows: [['']] });
    }
    let idx = state.sheetIndex[kind] || 0;
    if (idx >= sheets.length) idx = sheets.length - 1;
    state.sheetIndex[kind] = idx;
    const sheet = sheets[idx];
    const rows = ensureMinRows(sheet.rows || [['']]);
    sheet.rows = rows;

    const wrap = document.createElement('div');
    wrap.className = 'pn-hot-wrap w-full';
    wrap.style.minHeight = '320px';
    $('pnHotContainer').appendChild(wrap);

    const h = Math.min(560, Math.max(320, window.innerHeight - 320));
    state.hot = new Handsontable(wrap, {
      data: rows,
      stretchH: 'all',
      rowHeaders: true,
      colHeaders: true,
      height: h,
      licenseKey: 'non-commercial-and-evaluation',
      layoutDirection: 'rtl',
      contextMenu: true,
      manualColumnResize: true,
      manualRowResize: true,
      afterChange: function () {
        const sh = state.workbooks[kind].sheets[state.sheetIndex[kind]];
        sh.rows = hotDataToRows(state.hot);
      },
    });
  }

  function renderSheetTabs() {
    const kind = state.mainTab;
    const sheets = state.workbooks[kind].sheets;
    const wrap = $('pnSheetTabsWrap');
    wrap.innerHTML = '';
    sheets.forEach(function (s, i) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'px-3 py-1.5 rounded-lg text-sm border ' +
        (i === state.sheetIndex[kind] ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50');
      btn.textContent = s.name || 'ورقة ' + (i + 1);
      btn.dataset.idx = String(i);
      btn.addEventListener('click', function () {
        syncCurrentSheetFromHot();
        state.sheetIndex[kind] = i;
        renderSheetTabs();
        renderHot();
      });
      wrap.appendChild(btn);
    });
  }

  function syncCurrentSheetFromHot() {
    if (!state.hot) return;
    const kind = state.mainTab;
    const idx = state.sheetIndex[kind];
    const sh = state.workbooks[kind].sheets[idx];
    if (sh) sh.rows = hotDataToRows(state.hot);
  }

  function setMainTab(tab) {
    syncCurrentSheetFromHot();
    state.mainTab = tab;
    document.querySelectorAll('.pn-main-tab').forEach(function (b) {
      const on = b.getAttribute('data-main') === tab;
      b.className =
        'pn-main-tab px-4 py-2 rounded-xl text-sm font-medium ' +
        (on ? 'bg-indigo-100 text-indigo-800' : 'text-slate-600 hover:bg-slate-100');
    });
    renderSheetTabs();
    renderHot();
  }

  async function loadCycles() {
    const body = $('pnListBody');
    try {
      const res = await fetch('/api/payroll-native/cycles');
      const data = await res.json();
      if (!data.success) {
        body.innerHTML = '<p class="text-red-600">' + (data.message || 'فشل التحميل') + '</p>';
        return;
      }
      if (!data.cycles || !data.cycles.length) {
        body.innerHTML = '<p class="text-slate-500">لا توجد دورات بعد. أنشئ دورة وارفع الملفات.</p>';
        return;
      }
      let html = '<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr class="text-right border-b border-slate-200">';
      html += '<th class="py-2 px-3">الاسم</th><th class="py-2 px-3">آخر تحديث</th><th class="py-2 px-3"></th></tr></thead><tbody>';
      data.cycles.forEach(function (c) {
        const d = c.updated_at ? new Date(c.updated_at).toLocaleString('ar') : '—';
        html +=
          '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
          '<td class="py-2 px-3 font-medium text-slate-800">' +
          escapeHtml(c.name) +
          '</td>' +
          '<td class="py-2 px-3 text-slate-500">' +
          d +
          '</td>' +
          '<td class="py-2 px-3 whitespace-nowrap">' +
          '<button type="button" class="text-indigo-600 font-medium pn-open" data-id="' +
          c.id +
          '">فتح</button> ' +
          '<button type="button" class="text-red-600 mr-2 pn-del" data-id="' +
          c.id +
          '">حذف</button>' +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
      body.innerHTML = html;
      body.querySelectorAll('.pn-open').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openCycle(parseInt(btn.getAttribute('data-id'), 10));
        });
      });
      body.querySelectorAll('.pn-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
          deleteCycle(parseInt(btn.getAttribute('data-id'), 10));
        });
      });
    } catch (e) {
      body.innerHTML = '<p class="text-red-600">' + e.message + '</p>';
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function deleteCycle(id) {
    if (!confirm('حذف هذه الدورة نهائياً؟')) return;
    try {
      const res = await fetch('/api/payroll-native/cycles/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || 'تم الحذف', 'success');
        loadCycles();
      } else showToast(data.message || 'فشل', 'error');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function openCycle(id) {
    try {
      const res = await fetch('/api/payroll-native/cycles/' + id);
      const data = await res.json();
      if (!data.success) {
        showToast(data.message || 'فشل', 'error');
        return;
      }
      state.cycleId = id;
      state.workbooks.management = data.management || { sheets: [{ name: 'ورقة1', rows: [['']] }] };
      state.workbooks.agent = data.agent || { sheets: [{ name: 'ورقة1', rows: [['']] }] };
      state.workbooks.userInfo = data.userInfo || { sheets: [{ name: 'ورقة1', rows: [['']] }] };
      state.settings = data.settings || {};
      state.sheetIndex = { management: 0, agent: 0, userInfo: 0 };
      state.mainTab = 'management';

      $('pnCycleName').value = data.cycle.name || '';

      const ps = await fetch('/api/sheet/payroll-settings');
      const pset = await ps.json();
      if (pset.success) {
        $('pnDiscount').value = pset.discountRate ?? 0;
        $('pnColorAgent').value = pset.agentColor || '#3b82f6';
        $('pnColorMgmt').value = pset.managementColor || '#10b981';
      }

      $('pnUserInfoSheetIdx').value = state.settings.user_info_sheet_index ?? 0;
      setSelectValue('pnColUiUid', state.settings.user_info_user_id_col || 'C');
      setSelectValue('pnColUiTitle', state.settings.user_info_title_col || 'D');
      setSelectValue('pnColUiSal', state.settings.user_info_salary_col || 'L');
      setSelectValue('pnColMgmt', state.settings.mgmt_user_id_col || 'A');
      setSelectValue('pnColAgentUid', state.settings.agent_user_id_col || 'A');
      setSelectValue('pnColAgentSal', state.settings.agent_salary_col || 'D');

      $('pnListView').classList.add('hidden');
      $('pnEditorView').classList.remove('hidden');
      $('pnResultsSection').classList.add('hidden');

      setMainTab('management');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  function closeEditor() {
    syncCurrentSheetFromHot();
    state.cycleId = null;
    destroyHot();
    $('pnEditorView').classList.add('hidden');
    $('pnListView').classList.remove('hidden');
    loadCycles();
  }

  function readSettingsFromForm() {
    return {
      mgmt_user_id_col: $('pnColMgmt').value,
      agent_user_id_col: $('pnColAgentUid').value,
      agent_salary_col: $('pnColAgentSal').value,
      user_info_user_id_col: $('pnColUiUid').value,
      user_info_title_col: $('pnColUiTitle').value,
      user_info_salary_col: $('pnColUiSal').value,
      user_info_sheet_index: parseInt($('pnUserInfoSheetIdx').value, 10) || 0,
    };
  }

  async function saveWorkbooks() {
    if (!state.cycleId) return;
    syncCurrentSheetFromHot();
    const settings = readSettingsFromForm();
    try {
      const res = await fetch('/api/payroll-native/cycles/' + state.cycleId + '/workbooks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          management: state.workbooks.management,
          agent: state.workbooks.agent,
          userInfo: state.workbooks.userInfo,
          settings: settings,
        }),
      });
      const data = await res.json();
      if (data.success) showToast(data.message || 'تم الحفظ', 'success');
      else showToast(data.message || 'فشل', 'error');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function saveCycleName() {
    if (!state.cycleId) return;
    const name = ($('pnCycleName').value || '').trim();
    if (!name) {
      showToast('أدخل اسماً', 'error');
      return;
    }
    try {
      const res = await fetch('/api/payroll-native/cycles/' + state.cycleId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      });
      const data = await res.json();
      if (data.success) showToast(data.message || 'تم', 'success');
      else showToast(data.message || 'فشل', 'error');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  function buildAuditHtml(data) {
    var s = data.summary || {};
    var html = '';
    html += '<p class="text-xs text-slate-500 mb-2"><i class="fas fa-server ml-1"></i> تدقيق داخل LorkERP — لم يُكتب على Google.</p>';
    html += '<p class="font-semibold text-slate-800 mb-2">' + escapeHtml(data.message || '') + '</p>';
    html += '<ul class="space-y-1 text-slate-600 mb-4 text-sm">';
    html += '<li>إجمالي: <strong>' + (s.total || 0) + '</strong></li>';
    html += '<li>سحب وكالة: <strong>' + (s.agent || 0) + '</strong></li>';
    html += '<li>سحب إدارة: <strong>' + (s.management || 0) + '</strong></li>';
    html += '<li>غير موجود: <strong>' + (s.notFound || 0) + '</strong></li></ul>';
    if (data.results && data.results.length) {
      html += '<div class="overflow-x-auto max-h-80 overflow-y-auto border border-slate-200 rounded-xl">';
      html += '<table class="min-w-full text-xs text-right"><thead><tr class="bg-slate-100">';
      html += '<th class="p-2">#</th><th class="p-2">المستخدم</th><th class="p-2">العنوان</th><th class="p-2">النوع</th></tr></thead><tbody>';
      data.results.forEach(function (r, i) {
        var bg = r.color ? 'background:' + r.color + ';color:#111' : '';
        html += '<tr style="' + bg + '"><td class="p-2">' + (i + 1) + '</td><td class="p-2">' + escapeHtml(String(r.userId || '')) + '</td><td class="p-2">' + escapeHtml(String(r.title || '')) + '</td><td class="p-2">' + escapeHtml(String(r.type || '')) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    if (data.diagnostic) {
      html += '<p class="text-amber-700 text-sm mt-3">راجع أعمدة التدقيق أو البيانات إذا كان التطابق صفراً.</p>';
    }
    return html;
  }

  async function runAudit() {
    if (!state.cycleId) return;
    syncCurrentSheetFromHot();
    await saveWorkbooks();
    const settings = readSettingsFromForm();
    const btn = $('pnAuditBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    try {
      const res = await fetch('/api/payroll-native/cycles/' + state.cycleId + '/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discountRate: parseFloat($('pnDiscount').value) || 0,
          agentColor: $('pnColorAgent').value,
          managementColor: $('pnColorMgmt').value,
          userInfoUserIdCol: settings.user_info_user_id_col,
          userInfoTitleCol: settings.user_info_title_col,
          userInfoSalaryCol: settings.user_info_salary_col,
          cycleMgmtUserIdCol: settings.mgmt_user_id_col,
          cycleAgentUserIdCol: settings.agent_user_id_col,
          cycleAgentSalaryCol: settings.agent_salary_col,
          userInfoSheetIndex: settings.user_info_sheet_index,
        }),
      });
      const data = await res.json();
      $('pnResultsSection').classList.remove('hidden');
      $('pnResultsBody').innerHTML = data.success ? buildAuditHtml(data) : '<p class="text-red-600">' + escapeHtml(data.message || 'فشل') + '</p>';
      if (data.success) showToast(data.message || 'تم التدقيق', 'success');
      else showToast(data.message || 'فشل', 'error');
    } catch (e) {
      $('pnResultsSection').classList.remove('hidden');
      $('pnResultsBody').innerHTML = '<p class="text-red-600">' + escapeHtml(e.message) + '</p>';
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-check-double"></i> تدقيق على السيرفر';
    }
  }

  async function exportKind(kind) {
    if (!state.cycleId) return;
    try {
      const res = await fetch('/api/payroll-native/cycles/' + state.cycleId + '/export/' + kind, { method: 'POST' });
      const data = await res.json();
      if (data.success && data.url) {
        showToast(data.message || 'تم التصدير', 'success');
        window.open(data.url, '_blank', 'noopener');
      } else showToast(data.message || 'فشل التصدير', 'error');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  function addSheet() {
    syncCurrentSheetFromHot();
    const kind = state.mainTab;
    const sheets = state.workbooks[kind].sheets;
    const n = sheets.length + 1;
    sheets.push({ name: 'ورقة ' + n, rows: [['']] });
    state.sheetIndex[kind] = sheets.length - 1;
    renderSheetTabs();
    renderHot();
  }

  async function replaceFile(file) {
    if (!file || !state.cycleId) return;
    const kind = state.mainTab;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind === 'userInfo' ? 'userInfo' : kind);
    try {
      const res = await fetch('/api/payroll-native/cycles/' + state.cycleId + '/upload', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (data.success && data.workbook) {
        state.workbooks[kind] = data.workbook;
        state.sheetIndex[kind] = 0;
        renderSheetTabs();
        renderHot();
        showToast(data.message || 'تم الاستبدال', 'success');
      } else showToast(data.message || 'فشل', 'error');
    } catch (e) {
      showToast(e.message, 'error');
    }
    $('pnReplaceFile').value = '';
  }

  document.addEventListener('DOMContentLoaded', function () {
    fillColSelects();
    loadCycles();

    $('pnCreateForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = $('pnCreateBtn');
      const fd = new FormData();
      fd.append('name', ($('pnNewName').value || '').trim());
      const f1 = $('pnFileMgmt').files[0];
      const f2 = $('pnFileAgent').files[0];
      const f3 = $('pnFileUser').files[0];
      if (f1) fd.append('management', f1);
      if (f2) fd.append('agent', f2);
      if (f3) fd.append('userInfo', f3);
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      }
      try {
        const res = await fetch('/api/payroll-native/cycles', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || 'تم', 'success');
          $('pnCreateForm').reset();
          $('pnNewName').value = '';
          loadCycles();
          if (data.cycleId) openCycle(data.cycleId);
        } else showToast(data.message || 'فشل', 'error');
      } catch (err) {
        showToast(err.message, 'error');
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus"></i> إنشاء الدورة';
      }
    });

    $('pnBackBtn').addEventListener('click', closeEditor);
    $('pnSaveSheetsBtn').addEventListener('click', saveWorkbooks);
    $('pnSaveNameBtn').addEventListener('click', saveCycleName);
    $('pnAuditBtn').addEventListener('click', runAudit);
    $('pnExportMgmt').addEventListener('click', function () {
      exportKind('management');
    });
    $('pnExportAgent').addEventListener('click', function () {
      exportKind('agent');
    });
    $('pnExportUser').addEventListener('click', function () {
      exportKind('userInfo');
    });
    $('pnAddSheetBtn').addEventListener('click', addSheet);
    $('pnReplaceFile').addEventListener('change', function () {
      if (this.files && this.files[0]) replaceFile(this.files[0]);
    });

    document.querySelectorAll('.pn-main-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        setMainTab(b.getAttribute('data-main'));
      });
    });

    window.addEventListener('resize', function () {
      if (state.hot && $('pnEditorView') && !$('pnEditorView').classList.contains('hidden')) renderHot();
    });
  });
})();
