async function saveSheetsConfig(e) {
  e.preventDefault();
  const data = {
    spreadsheet_id: document.getElementById('spreadsheetId').value,
    client_id: document.getElementById('clientId').value,
    client_secret: document.getElementById('clientSecret').value
  };
  const result = await apiCall('/sheets/configure', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  showToast(result.message, result.success ? 'success' : 'error');
  if (result.success) {
    setTimeout(() => location.reload(), 1500);
  }
}

async function toggleSync() {
  const result = await apiCall('/sheets/toggle-sync', { method: 'POST' });
  showToast(result.message, result.success ? 'success' : 'error');
  if (!result.success) {
    const toggle = document.getElementById('syncToggle');
    if (toggle) toggle.checked = !toggle.checked;
  }
}
