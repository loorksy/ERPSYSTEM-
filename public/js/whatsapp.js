const socket = io();

socket.on('whatsapp-qr', (data) => {
  showQRCode(data.qr);
});

socket.on('whatsapp-status', (data) => {
  updateWhatsAppUI(data.status, data.phone, data);
});

socket.on('whatsapp-loading', (data) => {
  const waStatusText = document.getElementById('waStatusText');
  if (waStatusText && data.percent) {
    waStatusText.textContent = `جاري التحميل ${data.percent}%`;
  }
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
  const btn = document.getElementById('btnDisconnect');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>جاري قطع الاتصال...</span>';
  }
  const result = await apiCall('/whatsapp/disconnect', { method: 'POST' });
  showToast(result.message, result.success ? 'success' : 'error');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-unlink"></i><span>قطع الاتصال</span>';
  }
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

function updateWhatsAppUI(status, phone, extra) {
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
      if (btnDisconnect) {
        btnDisconnect.style.display = 'flex';
        btnDisconnect.disabled = false;
        btnDisconnect.innerHTML = '<i class="fas fa-unlink"></i><span>قطع الاتصال</span>';
      }
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

    case 'connecting':
      updateStatusBadge('connecting', 'جاري الاتصال...');
      break;

    case 'reconnecting':
      if (placeholder) placeholder.style.display = 'none';
      if (qrCode) qrCode.style.display = 'none';
      if (waConnected) waConnected.style.display = 'none';
      if (btnConnect) btnConnect.style.display = 'none';
      if (btnDisconnect) btnDisconnect.style.display = 'none';
      const attempt = extra?.attempt || '?';
      const max = extra?.maxAttempts || '?';
      updateStatusBadge('connecting', `إعادة الاتصال (${attempt}/${max})`);
      showToast(`محاولة إعادة الاتصال ${attempt}/${max}`, 'error');
      break;

    case 'auth_failed':
      if (placeholder) placeholder.style.display = 'block';
      if (qrCode) qrCode.style.display = 'none';
      if (waConnected) waConnected.style.display = 'none';
      if (btnConnect) {
        btnConnect.style.display = 'flex';
        btnConnect.disabled = false;
        btnConnect.innerHTML = '<i class="fab fa-whatsapp"></i><span>إعادة المحاولة</span>';
      }
      if (btnDisconnect) btnDisconnect.style.display = 'none';
      updateStatusBadge('disconnected', 'فشل المصادقة');
      showToast('فشل مصادقة واتساب، يرجى إعادة المحاولة', 'error');
      break;
  }
}

function updateStatusBadge(status, text) {
  const badge = document.getElementById('waStatusBadge');
  if (!badge) return;
  const dot = badge.querySelector('.status-dot');
  const label = document.getElementById('waStatusText');
  if (dot) dot.className = 'status-dot ' + status;
  if (label) label.textContent = text;
}

(async function checkInitialStatus() {
  try {
    const result = await apiCall('/whatsapp/status');
    if (result.status === 'connected') {
      updateWhatsAppUI('connected', result.phone);
    } else if (result.qr) {
      showQRCode(result.qr);
    }
  } catch (e) {
    console.error('[WhatsApp UI] Status check error:', e);
  }
})();
