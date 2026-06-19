// ============================================================
// DWOJ 客户端脚本
// ============================================================

import './style.css';

// ------------------------------------------------------------
// Toast 通知系统
// ------------------------------------------------------------
type ToastType = 'success' | 'error' | 'info' | 'warning';

function showToast(message: string, type: ToastType = 'info', duration = 3000): void {
  let container = document.querySelector<HTMLDivElement>('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  toast.addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast: HTMLDivElement): void {
  if (toast.classList.contains('toast-hide')) return;
  toast.classList.add('toast-hide');
  setTimeout(() => toast.remove(), 300);
}

// ------------------------------------------------------------
// Loading 状态管理
// ------------------------------------------------------------
function setLoading(btn: HTMLButtonElement, loading: boolean): void {
  if (loading) {
    btn.classList.add('btn-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

// ------------------------------------------------------------
// 表单增强：AJAJ 提交（登录 / 注册）
// ------------------------------------------------------------
function enhanceAuthForm(form: HTMLFormElement): void {
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!btn) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoading(btn, true);

    try {
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());

      const res = await fetch(form.action, {
        method: form.method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data as Record<string, string>),
        redirect: 'manual',
      });

      if (res.status === 0 || res.type === 'opaqueredirect' || res.redirected) {
        // 登录/注册成功 → 页面跳转
        window.location.href = '/';
        return;
      }

      const text = await res.text();
      if (res.ok && text.length < 100 && !text.includes('服务器错误')) {
        showToast('操作成功！', 'success');
        window.location.href = '/';
      } else {
        // 后端返回了错误消息
        showToast(text || '操作失败', 'error');
        setLoading(btn, false);
      }
    } catch (err) {
      showToast('网络错误，请重试', 'error');
      setLoading(btn, false);
    }
  });
}

// ------------------------------------------------------------
// 代码提交表单增强
// ------------------------------------------------------------
function enhanceSubmitForm(form: HTMLFormElement): void {
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!btn) return;

  form.addEventListener('submit', () => {
    setLoading(btn, true);
    btn.textContent = '提交中...';
  });
}

// ------------------------------------------------------------
// 状态页自动刷新
// ------------------------------------------------------------
function initStatusAutoRefresh(): void {
  const statusTable = document.querySelector('.table');
  if (!statusTable) return;

  // 检查页面是否包含 Pending/Running 的状态
  const hasPending = document.querySelector('.spinner-border');
  if (!hasPending) return;

  let countdown = 5;

  const indicator = document.createElement('div');
  indicator.className = 'text-muted small text-center mt-2';
  indicator.textContent = `自动刷新中 (${countdown}s)`;
  statusTable.parentElement?.appendChild(indicator);

  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = 5;
      window.location.reload();
    }
    indicator.textContent = `自动刷新中 (${countdown}s)`;
  }, 1000);
}

// ------------------------------------------------------------
// 通用工具
// ------------------------------------------------------------
function init(): void {
  // Toast 暴露到全局，EJS 模板中也可用
  (window as any).showToast = showToast;

  // 增强登录表单
  const loginForm = document.querySelector<HTMLFormElement>('form[action="/login"]');
  if (loginForm) enhanceAuthForm(loginForm);

  // 增强注册表单
  const registerForm = document.querySelector<HTMLFormElement>('form[action="/register"]');
  if (registerForm) enhanceAuthForm(registerForm);

  // 增强代码提交表单
  const submitForm = document.querySelector<HTMLFormElement>('form[action="/submit"]');
  if (submitForm) enhanceSubmitForm(submitForm);

  // 状态页自动刷新
  initStatusAutoRefresh();
}

// ------------------------------------------------------------
// DOM Ready
// ------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}