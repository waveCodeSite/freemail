/**
 * 分享收件箱页面
 * @module share
 */

import { renderEmailList, generateSkeletonList, filterEmails, countUnread } from './modules/mailbox/email-list.js';
import { renderEmailDetail, sanitizeHtml } from './modules/mailbox/email-detail.js';

const showToast = window.showToast || ((msg, type) => console.log(`[${type}] ${msg}`));

// 从 URL 路径提取 token: /share/<token>
const token = (() => {
  const match = location.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_) {
    return match[1].trim();
  }
})();

// 状态
let emails = [], currentPage = 1;
const pageSize = 20;
let autoRefreshTimer = null, keyword = '';

// DOM 元素
const els = {
  shareExpired: document.getElementById('share-expired'),
  shareContent: document.getElementById('share-content'),
  errorTitle: document.getElementById('share-error-title'),
  errorDesc: document.getElementById('share-error-desc'),
  currentMailbox: document.getElementById('current-mailbox'),
  expiresHint: document.getElementById('share-expires-hint'),
  refreshEmailsBtn: document.getElementById('refresh-emails'),
  emailList: document.getElementById('email-list'),
  emptyState: document.getElementById('empty-state'),
  listLoading: document.getElementById('list-loading'),
  listPager: document.getElementById('list-pager'),
  prevPageBtn: document.getElementById('prev-page'),
  nextPageBtn: document.getElementById('next-page'),
  pageInfo: document.getElementById('page-info'),
  emailModal: document.getElementById('email-modal'),
  modalSubject: document.getElementById('modal-subject'),
  modalContent: document.getElementById('modal-content'),
  modalCloseBtn: document.getElementById('modal-close'),
  autoRefresh: document.getElementById('auto-refresh'),
  refreshInterval: document.getElementById('refresh-interval'),
  searchBox: document.getElementById('search-box'),
  clearFilter: document.getElementById('clear-filter')
};

/** 显示过期/无效页面 */
function showExpired(title = '分享链接无效或已过期', desc = '该链接可能已被撤销或已超过有效期') {
  if (els.errorTitle) els.errorTitle.textContent = title;
  if (els.errorDesc) els.errorDesc.textContent = desc;
  if (els.shareExpired) els.shareExpired.style.display = '';
  if (els.shareContent) els.shareContent.style.display = 'none';
  stopAutoRefresh();
}

/** 显示主内容 */
function showContent() {
  if (els.shareExpired) els.shareExpired.style.display = 'none';
  if (els.shareContent) els.shareContent.style.display = '';
}

/** 格式化过期时间提示 */
function formatExpiresHint(expiresAt) {
  if (!expiresAt) return '永不过期';
  try {
    const d = new Date(expiresAt);
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return '已过期';
    if (diff < 3600000) return `${Math.ceil(diff / 60000)} 分钟后过期`;
    if (diff < 86400000) return `${Math.ceil(diff / 3600000)} 小时后过期`;
    return `${Math.ceil(diff / 86400000)} 天后过期`;
  } catch (_) {
    return '';
  }
}

/** API 请求 */
async function api(path) {
  const r = await fetch(path, { headers: { 'Cache-Control': 'no-cache' } });
  if (r.status === 404) {
    showExpired();
    throw new Error('share_invalid');
  }
  if (!r.ok) {
    throw new Error(`share_request_failed:${r.status}`);
  }
  return r;
}

/** 初始化：获取分享信息 */
async function init() {
  if (!token) { showExpired(); return; }

  try {
    const r = await api(`/api/share/${encodeURIComponent(token)}/info`);
    const info = await r.json();
    if (info.error) { showExpired(); return; }

    showContent();
    if (els.currentMailbox) els.currentMailbox.textContent = info.address;
    document.title = `${info.address} - 分享收件箱`;

    // 过期时间提示
    if (els.expiresHint) {
      const hint = formatExpiresHint(info.expires_at);
      if (hint) {
        els.expiresHint.textContent = hint;
        els.expiresHint.style.display = '';
      }
    }

    await loadEmails();
    startAutoRefresh();
  } catch (e) {
    if (e.message !== 'share_invalid') {
      console.error('初始化分享页面失败:', e);
      showExpired('分享页面加载失败', '服务器暂时无法返回分享内容，请稍后重试');
    }
  }
}

/** 加载邮件列表 */
async function loadEmails() {
  if (els.listLoading) els.listLoading.style.display = 'flex';
  if (els.emailList) els.emailList.innerHTML = generateSkeletonList(5);

  try {
    const r = await api(`/api/share/${encodeURIComponent(token)}/emails?limit=50`);
    emails = await r.json();
    if (!Array.isArray(emails)) emails = [];
    renderEmails();
  } catch (e) {
    if (e.message !== 'share_invalid') {
      console.error('加载邮件失败:', e);
      showToast('加载失败', 'error');
    }
  } finally {
    if (els.listLoading) els.listLoading.style.display = 'none';
  }
}

/** 渲染邮件列表 */
function renderEmails() {
  let filtered = filterEmails(emails, keyword);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  if (!pageItems.length) {
    if (els.emailList) els.emailList.innerHTML = '';
    if (els.emptyState) els.emptyState.style.display = 'block';
    if (els.listPager) els.listPager.style.display = 'none';
  } else {
    renderEmailList(pageItems, els.emailList);
    if (els.emptyState) els.emptyState.style.display = 'none';

    // 绑定点击事件
    els.emailList.querySelectorAll('.email-item').forEach(item => {
      item.onclick = () => showEmail(item.dataset.emailId);
    });

    if (els.listPager) els.listPager.style.display = total > pageSize ? 'flex' : 'none';
    if (els.pageInfo) els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
    if (els.prevPageBtn) els.prevPageBtn.disabled = currentPage <= 1;
    if (els.nextPageBtn) els.nextPageBtn.disabled = currentPage >= totalPages;
  }
}

/** 显示邮件详情 */
async function showEmail(id) {
  try {
    const r = await api(`/api/share/${encodeURIComponent(token)}/email/${id}`);
    const email = await r.json();

    if (els.modalSubject) els.modalSubject.textContent = email.subject || '(无主题)';
    if (els.modalContent) els.modalContent.innerHTML = renderEmailDetail(email);

    // 绑定验证码复制
    els.modalContent?.querySelectorAll('.code-value').forEach(el => {
      el.onclick = async () => {
        const code = el.dataset.code || el.textContent;
        try { await navigator.clipboard.writeText(code); showToast('已复制', 'success'); }
        catch (_) { showToast('复制失败', 'error'); }
      };
    });

    els.emailModal?.classList.add('show');
  } catch (e) {
    if (e.message !== 'share_invalid') {
      showToast('加载邮件失败', 'error');
    }
  }
}

/** 自动刷新 */
function startAutoRefresh() {
  stopAutoRefresh();
  const interval = parseInt(els.refreshInterval?.value || '30', 10) * 1000;
  if (els.autoRefresh?.checked) {
    autoRefreshTimer = setInterval(loadEmails, interval);
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

// 事件绑定
els.refreshEmailsBtn?.addEventListener('click', async () => {
  const icon = els.refreshEmailsBtn.querySelector('.btn-icon');
  if (icon) icon.classList.add('spinning');
  els.refreshEmailsBtn.disabled = true;
  try {
    await loadEmails();
    showToast('刷新成功', 'success');
  } finally {
    if (icon) icon.classList.remove('spinning');
    els.refreshEmailsBtn.disabled = false;
  }
});

els.prevPageBtn?.addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; renderEmails(); }
});
els.nextPageBtn?.addEventListener('click', () => {
  const totalPages = Math.ceil(filterEmails(emails, keyword).length / pageSize);
  if (currentPage < totalPages) { currentPage++; renderEmails(); }
});

els.modalCloseBtn?.addEventListener('click', () => els.emailModal?.classList.remove('show'));
els.emailModal?.addEventListener('click', e => {
  if (e.target === els.emailModal) els.emailModal.classList.remove('show');
});

els.autoRefresh?.addEventListener('change', startAutoRefresh);
els.refreshInterval?.addEventListener('change', startAutoRefresh);

els.searchBox?.addEventListener('input', () => {
  keyword = els.searchBox.value;
  currentPage = 1;
  renderEmails();
});
els.clearFilter?.addEventListener('click', () => {
  keyword = '';
  if (els.searchBox) els.searchBox.value = '';
  currentPage = 1;
  renderEmails();
});

// 初始化
document.addEventListener('DOMContentLoaded', init);
