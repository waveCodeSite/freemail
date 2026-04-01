# 分享链接功能

## 功能概述

为邮箱生成免登录的分享链接，任何人打开链接即可查看该邮箱的收件箱，无需登录。支持设置过期时间，过期后链接自动失效。

### URL 格式

```
https://your-domain.com/share/<token>
```

`token` 为 32 位随机字符串，存储在 `mailboxes` 表中。

---

## 数据库变更

`mailboxes` 表新增两个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `share_token` | TEXT DEFAULT NULL | 32 位随机分享 token，唯一索引 |
| `share_expires_at` | TEXT DEFAULT NULL | ISO 8601 过期时间，NULL 表示永不过期 |

### 迁移 SQL

对已有数据库执行：

```sql
ALTER TABLE mailboxes ADD COLUMN share_token TEXT DEFAULT NULL;
ALTER TABLE mailboxes ADD COLUMN share_expires_at TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_share_token ON mailboxes(share_token);
```

---

## API 文档

### 分享管理 API（需认证）

#### POST /api/mailbox/share — 生成分享链接

请求体：

```json
{
  "address": "user@domain.com",
  "expires": "24h"
}
```

`expires` 可选值：`1h`、`6h`、`24h`、`7d`、`30d`、`never`

响应：

```json
{
  "share_token": "a1b2c3d4e5f6...",
  "share_url": "/share/a1b2c3d4e5f6...",
  "expires_at": "2026-04-02T12:00:00.000Z"
}
```

- 如已有未过期 token，复用并更新过期时间
- 如无 token 或已过期，生成新 token

#### GET /api/mailbox/share — 查询分享状态

参数：`?address=user@domain.com`

响应：

```json
{
  "shared": true,
  "share_token": "a1b2c3d4e5f6...",
  "share_url": "/share/a1b2c3d4e5f6...",
  "expires_at": "2026-04-02T12:00:00.000Z",
  "expired": false
}
```

#### DELETE /api/mailbox/share — 撤销分享

参数：`?address=user@domain.com`

响应：

```json
{ "success": true }
```

将 `share_token` 和 `share_expires_at` 置为 NULL。

---

### 分享数据 API（免认证）

所有端点通过 token 访问，无需登录。token 无效或过期统一返回 404。

#### GET /api/share/:token/info — 邮箱基本信息

响应：

```json
{
  "address": "user@domain.com",
  "expires_at": "2026-04-02T12:00:00.000Z"
}
```

#### GET /api/share/:token/emails — 邮件列表

参数：`?limit=20`（最大 50）

响应：邮件数组，与 `/api/emails` 格式一致。

```json
[
  {
    "id": 1,
    "sender": "noreply@example.com",
    "subject": "欢迎",
    "received_at": "2026-04-01T10:00:00Z",
    "is_read": 0,
    "preview": "...",
    "verification_code": null
  }
]
```

#### GET /api/share/:token/email/:id — 邮件详情

响应：与 `/api/email/:id` 格式一致，包含 `content` 和 `html_content`。

验证邮件属于该 token 对应的邮箱，不属于则返回 404。

#### 错误响应

```json
// 404
"分享链接无效或已过期"
```

---

## 前端页面

### 分享页面 `/share/<token>`

- 路径 `/share/<token>` 由服务端返回 `share.html` 静态页面
- 前端 JS 从 URL 路径提取 token，调用分享 API 获取数据
- 只读页面：无登录/退出/删除/密码修改等操作
- 支持邮件列表浏览、邮件详情查看、搜索过滤
- 支持自动刷新（30 秒间隔）
- 支持暗黑模式
- token 无效或过期时显示提示页面

### 主应用分享入口

邮箱操作区新增"分享邮箱"按钮，点击弹出分享对话框：

- 选择有效期（1小时/6小时/24小时/7天/30天/永不过期）
- 生成后显示链接 + 一键复制
- 已有分享链接时显示当前链接和过期时间
- 支持撤销分享

---

## 文件清单

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| 修改 | `d1-init.sql` | 添加 share_token、share_expires_at 字段和索引 |
| 修改 | `src/middleware/auth.js` | `/api/share/` 路径免认证 |
| 修改 | `src/api/index.js` | 引入 handleShareApi |
| 修改 | `src/api/mailboxes.js` | 添加分享管理 API（POST/GET/DELETE） |
| 修改 | `src/assets/manager.js` | `/share/<token>` 路径返回 share.html |
| 修改 | `public/html/app.html` | 添加分享按钮和分享对话框 |
| 修改 | `public/js/app.js` | 绑定分享事件 |
| 修改 | `public/js/modules/app/mailbox-actions.js` | 分享相关函数 |
| 修改 | `public/icons/sprites.svg` | 添加 share 图标 |
| 新建 | `src/api/share.js` | 免认证分享数据 API |
| 新建 | `public/html/share.html` | 分享收件箱页面 |
| 新建 | `public/js/share.js` | 分享页面逻辑 |
| 新建 | `docs/share.md` | 本文档 |

---

## 部署步骤

1. 对已有数据库执行迁移 SQL（见上方"数据库变更"）
2. 部署代码更新
3. 新部署会自动通过 `d1-init.sql` 创建完整表结构
