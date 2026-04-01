/**
 * 分享链接 API 模块（免认证）
 * @module api/share
 */

import { errorResponse } from './helpers.js';
import { parseEmailBody } from '../email/parser.js';
import { ensureMailboxesShareFields } from '../db/index.js';

/**
 * 通过 share_token 查询邮箱，验证 token 有效且未过期
 * @param {object} db - 数据库连接
 * @param {string} token - 分享 token
 * @returns {Promise<object|null>} 邮箱记录或 null
 */
async function resolveShareToken(db, token) {
  if (!token || typeof token !== 'string' || token.length < 8) return null;
  const row = await db.prepare(
    'SELECT id, address, share_token, share_expires_at FROM mailboxes WHERE share_token = ? LIMIT 1'
  ).bind(token).first();
  if (!row) return null;
  // 检查过期
  if (row.share_expires_at) {
    const expiresAt = new Date(row.share_expires_at).getTime();
    if (expiresAt <= Date.now()) return null;
  }
  return row;
}

/** 无效/过期 token 的统一错误响应 */
const INVALID_SHARE = () => errorResponse('分享链接无效或已过期', 404);

function parseShareApiPath(path) {
  const normalizedPath = String(path || '').replace(/\/+$/, '');
  const segments = (normalizedPath || '/').split('/');
  if (segments.length < 5) return null;

  let token = segments[3] || '';
  try {
    token = decodeURIComponent(token);
  } catch (_) { }
  token = token.trim();

  return {
    token,
    action: segments[4] || '',
    extra: segments[5] || ''
  };
}

/**
 * 处理分享相关 API（免认证）
 * @param {Request} request - HTTP 请求
 * @param {object} db - 数据库连接
 * @param {URL} url - 请求 URL
 * @param {string} path - 请求路径
 * @param {object} options - 选项
 * @returns {Promise<Response|null>} 响应或 null（未匹配）
 */
export async function handleShareApi(request, db, url, path, options) {
  if (request.method !== 'GET') return null;
  if (!path.startsWith('/api/share/')) return null;

  const r2 = options.r2;
  const sharePath = parseShareApiPath(path);
  if (!sharePath) return null;

  try {
    await ensureMailboxesShareFields(db);
  } catch (_) {
    return errorResponse('分享链接解析失败', 500);
  }

  const { token, action, extra } = sharePath;

  // 获取分享邮箱信息
  if (action === 'info') {
    let mailbox;
    try {
      mailbox = await resolveShareToken(db, token);
    } catch (e) {
      console.error('分享链接解析失败:', e);
      return errorResponse('分享链接解析失败', 500);
    }
    if (!mailbox) return INVALID_SHARE();
    return Response.json({
      address: mailbox.address,
      expires_at: mailbox.share_expires_at || null
    });
  }

  // 获取邮件列表
  if (action === 'emails') {
    let mailbox;
    try {
      mailbox = await resolveShareToken(db, token);
    } catch (e) {
      console.error('分享链接解析失败:', e);
      return errorResponse('分享链接解析失败', 500);
    }
    if (!mailbox) return INVALID_SHARE();

    try {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read, preview, verification_code
          FROM messages
          WHERE mailbox_id = ?
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailbox.id, limit).all();
        return Response.json(results || []);
      } catch (_) {
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read,
                 CASE WHEN content IS NOT NULL AND content <> ''
                      THEN SUBSTR(content, 1, 120)
                      ELSE SUBSTR(COALESCE(html_content, ''), 1, 120)
                 END AS preview
          FROM messages
          WHERE mailbox_id = ?
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailbox.id, limit).all();
        return Response.json(results || []);
      }
    } catch (e) {
      console.error('分享链接查询邮件失败:', e);
      return errorResponse('查询邮件失败', 500);
    }
  }

  // 获取单封邮件详情
  if (action === 'email' && extra) {
    const emailId = extra;
    let mailbox;
    try {
      mailbox = await resolveShareToken(db, token);
    } catch (e) {
      console.error('分享链接解析失败:', e);
      return errorResponse('分享链接解析失败', 500);
    }
    if (!mailbox) return INVALID_SHARE();

    try {
      // 验证邮件属于该邮箱
      const check = await db.prepare(
        'SELECT mailbox_id FROM messages WHERE id = ? LIMIT 1'
      ).bind(emailId).first();
      if (!check || check.mailbox_id !== mailbox.id) {
        return errorResponse('邮件不存在', 404);
      }

      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || results.length === 0) {
        return errorResponse('邮件不存在', 404);
      }

      const row = results[0];
      let content = '';
      let html_content = '';

      // 从 R2 读取邮件内容
      try {
        if (row.r2_object_key && r2) {
          const obj = await r2.get(row.r2_object_key);
          if (obj) {
            let raw = '';
            if (typeof obj.text === 'function') raw = await obj.text();
            else if (typeof obj.arrayBuffer === 'function') raw = await new Response(await obj.arrayBuffer()).text();
            else raw = await new Response(obj.body).text();
            const parsed = parseEmailBody(raw || '');
            content = parsed.text || '';
            html_content = parsed.html || '';
          }
        }
      } catch (_) { }

      // 回退到数据库内容
      if (!content && !html_content) {
        try {
          const fallback = await db.prepare(
            'SELECT content, html_content FROM messages WHERE id = ?'
          ).bind(emailId).all();
          const fr = (fallback?.results || [])[0] || {};
          content = content || fr.content || '';
          html_content = html_content || fr.html_content || '';
        } catch (_) { }
      }

      return Response.json({ ...row, content, html_content });
    } catch (e) {
      console.error('分享链接查询邮件详情失败:', e);
      return errorResponse('查询邮件详情失败', 500);
    }
  }

  return null;
}
