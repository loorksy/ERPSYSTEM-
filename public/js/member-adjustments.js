(function () {
  const memberId = document.getElementById('maMemberId');
  const kind = document.getElementById('maKind');
  const amount = document.getElementById('maAmount');
  const cycleId = document.getElementById('maCycleId');
  const notes = document.getElementById('maNotes');

  async function loadCycles() {
    if (!cycleId) return;
    try {
      const res = await fetch('/api/sheet/cycles', { credentials: 'same-origin' });
      const data = await res.json();
      if (!data.success || !data.cycles || !data.cycles.length) {
        cycleId.innerHTML = '<option value="">— لا توجد دورات —</option>';
        return;
      }
      cycleId.innerHTML =
        '<option value="">— اختر الدورة —</option>' +
        data.cycles.map(function (c) {
          return '<option value="' + c.id + '">' + (c.name || 'دورة #' + c.id) + '</option>';
        }).join('');
      if (data.cycles[0] && data.cycles[0].id) cycleId.value = String(data.cycles[0].id);
    } catch (_) {
      cycleId.innerHTML = '<option value="">— خطأ في التحميل —</option>';
    }
  }
  loadCycles();
  const syncSheet = document.getElementById('maSyncSheet');
  const uiUidCol = document.getElementById('maUiUidCol');
  const uiSalCol = document.getElementById('maUiSalCol');
  const btn = document.getElementById('maSubmitBtn');
  const pasteBtn = document.getElementById('maPasteBtn');
  const msg = document.getElementById('maMsg');

  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      memberId.value = (t || '').trim();
    } catch (_) {}
  });

  btn.addEventListener('click', async () => {
    msg.textContent = '';
    const cidRaw = cycleId ? (cycleId.value || '').trim() : '';
    const cid = cidRaw ? parseInt(cidRaw, 10) : null;
    const body = {
      memberUserId: (memberId.value || '').trim(),
      kind: kind.value,
      amount: parseFloat(amount.value),
      notes: (notes.value || '').trim() || null,
      cycleId: cid && !Number.isNaN(cid) ? cid : null,
      syncUserInfoSheet: syncSheet ? syncSheet.checked : true,
      userInfoUserIdCol: (uiUidCol && uiUidCol.value ? uiUidCol.value : 'C').trim() || 'C',
      userInfoSalaryCol: (uiSalCol && uiSalCol.value ? uiSalCol.value : 'L').trim() || 'L',
    };
    if (!body.memberUserId) {
      msg.textContent = 'أدخل رقم المستخدم';
      msg.className = 'text-sm text-center text-red-600';
      return;
    }
    if (!(body.amount > 0)) {
      msg.textContent = 'أدخل مبلغاً صالحاً';
      msg.className = 'text-sm text-center text-red-600';
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/api/member-adjustments/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      let data;
      try {
        data = await res.json();
      } catch (_) {
        msg.textContent = 'استجابة غير صالحة من الخادم (' + res.status + ')';
        msg.className = 'text-sm text-center text-red-600';
        btn.disabled = false;
        return;
      }
      if (res.status === 401) {
        msg.textContent = 'انتهت الجلسة — أعد تسجيل الدخول';
        msg.className = 'text-sm text-center text-red-600';
        btn.disabled = false;
        return;
      }
      if (data.success) {
        msg.textContent = data.message || 'تم';
        msg.className = 'text-sm text-center text-emerald-600';
        amount.value = '';
      } else {
        msg.textContent = data.message || 'فشل';
        msg.className = 'text-sm text-center text-red-600';
      }
    } catch (e) {
      msg.textContent = e.message || 'فشل';
      msg.className = 'text-sm text-center text-red-600';
    }
    btn.disabled = false;
  });
})();
