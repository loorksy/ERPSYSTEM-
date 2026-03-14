async function saveAIKey(provider) {
  const inputId = provider === 'openai' ? 'openaiKey' : 'geminiKey';
  const apiKey = document.getElementById(inputId).value.trim();
  if (!apiKey) { showToast('الرجاء إدخال مفتاح API', 'error'); return; }

  const res = await apiCall('/ai/save-key', { method: 'POST', body: JSON.stringify({ provider, apiKey }) });
  showToast(res.message, res.success ? 'success' : 'error');

  if (res.success && res.models) {
    populateModels(provider, res.models);
    document.getElementById(inputId).value = '';
  }
  loadAIStatus();
}

async function selectModel(provider, model) {
  if (!model) return;
  const res = await apiCall('/ai/select-model', { method: 'POST', body: JSON.stringify({ provider, model }) });
  showToast(res.message, res.success ? 'success' : 'error');
  loadAIStatus();
}

async function refreshModels(provider) {
  const res = await apiCall('/ai/refresh-models', { method: 'POST', body: JSON.stringify({ provider }) });
  if (res.success && res.models) {
    populateModels(provider, res.models);
    showToast('تم تحديث الموديلات', 'success');
  } else {
    showToast(res.message || 'فشل التحديث', 'error');
  }
}

function populateModels(provider, models) {
  const selectId = provider === 'openai' ? 'openaiModelSelect' : 'geminiModelSelect';
  const sectionId = provider === 'openai' ? 'openaiModelsSection' : 'geminiModelsSection';
  const select = document.getElementById(selectId);
  const section = document.getElementById(sectionId);

  select.innerHTML = '<option value="">اختر موديل...</option>';
  models.forEach(m => { select.innerHTML += `<option value="${m}">${m}</option>`; });
  section.classList.remove('hidden');
}

async function loadAIStatus() {
  try {
    const data = await apiCall('/ai/status');

    ['openai', 'gemini'].forEach(p => {
      const badge = document.getElementById(p + 'StatusBadge');
      const section = document.getElementById(p + 'ModelsSection');
      const select = document.getElementById(p + 'ModelSelect');

      if (data[p]?.configured) {
        badge.textContent = data[p].selectedModel ? '✓ ' + data[p].selectedModel : '✓ مُعدّ';
        badge.className = 'mr-auto text-xs font-medium py-1 px-3 rounded-full ' +
          (data[p].selectedModel ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600');

        if (data[p].models?.length) {
          populateModels(p, data[p].models);
          if (data[p].selectedModel) select.value = data[p].selectedModel;
        }
      } else {
        badge.textContent = 'غير مُعدّ';
        badge.className = 'mr-auto text-xs font-medium py-1 px-3 rounded-full bg-slate-100 text-slate-500';
        if (section) section.classList.add('hidden');
      }
    });
  } catch {}
}

document.addEventListener('DOMContentLoaded', loadAIStatus);
