(function () {
  const memberId = document.getElementById('maMemberId');
  const kind = document.getElementById('maKind');
  const amount = document.getElementById('maAmount');
  const cycleId = document.getElementById('maCycleId');
  const notes = document.getElementById('maNotes');
  const msg = document.getElementById('maMsg');

  function setMaMessage(text, variant) {
    if (!msg) return;
    msg.textContent = text || '';
    msg.classList.remove('text-slate-500', 'text-red-600', 'text-emerald-600', 'font-medium');
    if (variant === 'error') msg.classList.add('text-red-600');
    else if (variant === 'success') msg.classList.add('text-emerald-600', 'font-medium');
    else msg.classList.add('text-slate-500');
  }

  function initKindPills() {
    if (!kind) return;
    var tabs = document.querySelectorAll('.ma-kind-btn');
    if (!tabs.length) return;
    function sync() {
      var v = kind.value;
      tabs.forEach(function (btn) {
        var k = btn.getAttribute('data-ma-kind');
        var on = k === v;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('bg-white', on);
        btn.classList.toggle('shadow-md', on);
        btn.classList.toggle('ring-2', on);
        btn.classList.toggle('ring-indigo-500', on);
        btn.classList.toggle('text-indigo-900', on);
        btn.classList.toggle('bg-slate-100', !on);
        btn.classList.toggle('text-slate-600', !on);
      });
    }
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        kind.value = btn.getAttribute('data-ma-kind') || 'deduct';
        kind.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      });
    });
    kind.addEventListener('change', sync);
    sync();
  }

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
  initKindPills();
  const syncSheet = document.getElementById('maSyncSheet');
  const uiUidCol = document.getElementById('maUiUidCol');
  const uiSalCol = document.getElementById('maUiSalCol');
  const btn = document.getElementById('maSubmitBtn');
  const pasteBtn = document.getElementById('maPasteBtn');

  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      memberId.value = (t || '').trim();
    } catch (_) {}
  });

  btn.addEventListener('click', async () => {
    setMaMessage('', 'neutral');
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
      setMaMessage('أدخل رقم المستخدم', 'error');
      return;
    }
    if (!(body.amount > 0)) {
      setMaMessage('أدخل مبلغاً صالحاً', 'error');
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
        setMaMessage('استجابة غير صالحة من الخادم (' + res.status + ')', 'error');
        btn.disabled = false;
        return;
      }
      if (res.status === 401) {
        setMaMessage('انتهت الجلسة — أعد تسجيل الدخول', 'error');
        btn.disabled = false;
        return;
      }
      if (data.success) {
        setMaMessage(data.message || 'تم', 'success');
        amount.value = '';
      } else {
        setMaMessage(data.message || 'فشل', 'error');
      }
    } catch (e) {
      setMaMessage(e.message || 'فشل', 'error');
    }
    btn.disabled = false;
  });
})();
