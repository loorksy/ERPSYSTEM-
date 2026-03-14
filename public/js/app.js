document.addEventListener('DOMContentLoaded', () => {
  initSidebar();
  initDate();
});

function initSidebar() {
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebarClose = document.getElementById('sidebarClose');

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.remove('max-lg:translate-x-full');
      sidebar.classList.add('translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
      sidebarOverlay.classList.remove('hidden');
      sidebarOverlay.classList.add('block');
      document.body.style.overflow = 'hidden';
    });
  }

  function closeSidebar() {
    sidebar.classList.add('max-lg:translate-x-full');
    sidebar.classList.remove('translate-x-0', 'shadow-[-4px_0_24px_rgba(0,0,0,0.2)]');
    sidebarOverlay.classList.add('hidden');
    sidebarOverlay.classList.remove('block');
    document.body.style.overflow = '';
  }

  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);

  let startX = 0;
  let currentX = 0;
  let isDragging = false;

  sidebar?.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    isDragging = true;
  });

  sidebar?.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    currentX = e.touches[0].clientX;
    const diff = currentX - startX;
    if (diff > 0) {
      sidebar.style.transform = `translateX(${diff}px)`;
    }
  });

  sidebar?.addEventListener('touchend', () => {
    isDragging = false;
    const diff = currentX - startX;
    if (diff > 80) {
      closeSidebar();
    }
    sidebar.style.transform = '';
    currentX = 0;
    startX = 0;
  });
}

function initDate() {
  const dateEl = document.getElementById('currentDate');
  if (dateEl) {
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateEl.textContent = now.toLocaleDateString('ar-SA', options);
  }
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i>
    <span>${message}</span>
    <button class="mr-auto text-slate-400 p-1 cursor-pointer" onclick="this.parentElement.remove()">
      <i class="fas fa-times"></i>
    </button>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

async function apiCall(url, options = {}) {
  try {
    const defaults = {
      headers: { 'Content-Type': 'application/json' },
    };
    const res = await fetch(url, { ...defaults, ...options });
    return await res.json();
  } catch (err) {
    console.error('API Error:', err);
    return { success: false, message: 'خطأ في الاتصال بالخادم' };
  }
}

async function updateProfile(e) {
  e.preventDefault();
  const displayName = document.getElementById('displayName').value;
  const result = await apiCall('/settings/update-profile', {
    method: 'POST',
    body: JSON.stringify({ displayName })
  });
  showToast(result.message, result.success ? 'success' : 'error');
  if (result.success) {
    setTimeout(() => location.reload(), 1000);
  }
}

async function changePassword(e) {
  e.preventDefault();
  const data = {
    currentPassword: document.getElementById('currentPassword').value,
    newPassword: document.getElementById('newPassword').value,
    confirmPassword: document.getElementById('confirmPassword').value
  };
  const result = await apiCall('/settings/change-password', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  showToast(result.message, result.success ? 'success' : 'error');
  if (result.success) {
    document.getElementById('passwordForm').reset();
  }
}
