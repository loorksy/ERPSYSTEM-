const socket = io();

socket.on('whatsapp-qr', (data) => {
  showQRCode(data.qr);
});

socket.on('whatsapp-status', (data) => {
  updateWhatsAppUI(data.status, data.phone);
});

async function connectWhatsApp() {
  const btn = document.getElementById('btnConnect');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>جاري الاتصال...</span>';

  const result = await apiCall('/whatsapp/connect', { method: 'POST' });
  if (!result.success) {
    showToast(result.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fab fa-whatsapp"></i><span>بدء الاتصال</span>';
  }
}

async function disconnectWhatsApp() {
  const result = await apiCall('/whatsapp/disconnect', { method: 'POST' });
  showToast(result.message, result.success ? 'success' : 'error');
}

function showQRCode(qrDataUrl) {
  const placeholder = document.getElementById('qrPlaceholder');
  const qrCode = document.getElementById('qrCode');
  const qrImage = document.getElementById('qrImage');
  const waConnected = document.getElementById('waConnected');

  if (placeholder) placeholder.style.display = 'none';
  if (waConnected) waConnected.style.display = 'none';
  if (qrCode) qrCode.style.display = 'block';
  if (qrImage) qrImage.src = qrDataUrl;

  updateStatusBadge('connecting', 'جاري الربط...');
}

function updateWhatsAppUI(status, phone) {
  const placeholder = document.getElementById('qrPlaceholder');
  const qrCode = document.getElementById('qrCode');
  const waConnected = document.getElementById('waConnected');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const connectedPhone = document.getElementById('connectedPhone');

  switch (status) {
    case 'connected':
      if (placeholder) placeholder.style.display = 'none';
      if (qrCode) qrCode.style.display = 'none';
      if (waConnected) waConnected.style.display = 'block';
      if (connectedPhone) connectedPhone.textContent = phone ? `الرقم: ${phone}` : '';
      if (btnConnect) btnConnect.style.display = 'none';
      if (btnDisconnect) btnDisconnect.style.display = 'flex';
      updateStatusBadge('connected', 'متصل');
      showToast('تم ربط واتساب بنجاح', 'success');
      break;

    case 'disconnected':
      if (placeholder) placeholder.style.display = 'block';
      if (qrCode) qrCode.style.display = 'none';
      if (waConnected) waConnected.style.display = 'none';
      if (btnConnect) {
        btnConnect.style.display = 'flex';
        btnConnect.disabled = false;
        btnConnect.innerHTML = '<i class="fab fa-whatsapp"></i><span>بدء الاتصال</span>';
      }
      if (btnDisconnect) btnDisconnect.style.display = 'none';
      updateStatusBadge('disconnected', 'غير متصل');
      break;

    case 'auth_failed':
      if (placeholder) placeholder.style.display = 'block';
      if (qrCode) qrCode.style.display = 'none';
      if (btnConnect) {
        btnConnect.disabled = false;
        btnConnect.innerHTML = '<i class="fab fa-whatsapp"></i><span>إعادة المحاولة</span>';
      }
      updateStatusBadge('disconnected', 'فشل المصادقة');
      showToast('فشل مصادقة واتساب', 'error');
      break;
  }
}

function updateStatusBadge(status, text) {
  const badge = document.getElementById('waStatusBadge');
  if (!badge) return;
  const dot = badge.querySelector('.status-dot');
  const label = document.getElementById('waStatusText');
  if (dot) {
    dot.className = 'status-dot ' + status;
  }
  if (label) {
    label.textContent = text;
  }
}

(async function checkInitialStatus() {
  try {
    const result = await apiCall('/whatsapp/status');
    if (result.status === 'connected') {
      updateWhatsAppUI('connected');
    } else if (result.qr) {
      showQRCode(result.qr);
    }
  } catch (e) {
    // Silently handle
  }
})();
