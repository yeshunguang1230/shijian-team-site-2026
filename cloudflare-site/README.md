# 史鉴 · 云端团队网站

固定入口：https://shijian-team-site-public.pages.dev/

## 使用方式

- 游客：直接访问公开首页和学习空间，只能读取已发布史料。
- 三名开发者：分别在 `/login.html` 使用独立账号，首次必须修改临时密码。登录后进入 `/admin.html`，管理共享史料、团队建议和规则设置。
- 导入资料：后台「共享史料」选择 PDF、Word（.docx）、TXT 或 Markdown，检查提取出的正文、补充出处，先保存草稿再发布。无需编写 JSON。
- 云端保存的是提取出的正文及填写的信息；不保存原附件。支持文字 PDF，扫描件需要先做文字识别。单文件最大 10 MB，PDF 最大 200 页，正文最大 20 万字符。
- 三人共用一份云端数据库。保存成功后，其他成员点击刷新即可看到；这不是多人实时共同编辑器。修改同一资料有版本冲突保护。
- 当前尚未配置模型服务，学习空间明确标识规则演示。网站、登录、资料和建议功能不依赖模型服务。

## 架构

Cloudflare Pages 提供固定网址和静态页面，并同源代理 `/api/*` 到 Cloudflare Worker。Worker 提供认证、权限校验、资料和建议接口，D1 存储用户、会话、史料和团队记录。电脑关机后，已部署网站与云端数据仍可使用。

`public/` 是公开资源；`src/` 是后台代码；`pages/_worker.js` 是 Pages 代理；`migrations/` 是数据库迁移；`scripts/` 是部署辅助脚本。构建只复制公开资源及 Pages 代理，不上传账号文件、数据库备份、项目私有文档或开发环境。

## 账号与安全

仅创建三个开发者账号，没有公开注册入口。账号文件在工作区私有目录中单独保存，每人只接收自己的一份。密码使用带随机盐的 PBKDF2-SHA256 哈希；D1 不保存明文密码。会话使用 Secure、HttpOnly、SameSite=Lax Cookie，数据库仅保存会话令牌哈希。改密撤销该账号旧会话，退出撤销当前会话。

私有 API 在服务端检查身份；首次改密前不能访问后台数据。旧版团队邀请码和管理员令牌已不再接受。跨站写请求会检查来源；登录有速率限制。新增史料默认草稿，只有明确发布的内容对游客开放。升级保留旧数据，旧史料暂存为草稿。

## 开发与验证

```powershell
npm ci
npm run check
npm run check:e2e
npx wrangler deploy --dry-run
```

端到端测试使用独立本地 D1 和测试账号，覆盖三个账号、强制改密、会话轮换/退出、旧令牌无效、草稿保护、版本冲突、发布可见、作者身份和重启持久化。

## 部署

现有 D1 已绑定于 `wrangler.json`，正常更新无需新建数据库或重新创建账号。

```powershell
npx wrangler d1 migrations apply shijian-team-db --remote
npx wrangler deploy
npx wrangler deploy --name shijian-team-site-2026-pages
npm run build:pages
$pagesDirectory = (Get-Content .pages-build/latest.txt -Raw).Trim()
npx wrangler pages deploy $pagesDirectory --project-name shijian-team-site-public --branch main --commit-dirty=true
```

两个 Worker 共用数据库，发布安全更新时需要同时升级，避免旧入口继续使用旧规则。Pages 的固定域名已列在 Worker 允许来源中；启用新域名时需同步配置。

首次账号初始化通过 `scripts/prepare-accounts.mjs` 在部署目录之外生成私有文件，再将该私有 seed SQL 导入 D1；不要重复生成或提交到 Git。已有账号的密码不能从数据库还原，遗失时由维护者安全重置。

真实 AI 需要在 Worker 服务端分别配置 `SHIJIAN_BASE_URL`、`SHIJIAN_API_KEY`、`SHIJIAN_MODEL`。密钥不能写进网页、公开仓库或群聊。配置后仍须实际验证模型调用，不能仅凭配置状态宣称 AI 可用。

公网可访问性受各设备的网络路径和服务状态影响。本版通过固定 Pages 域名访问，不要求三人在同一局域网。跨设备展示前仍应在展示现场网络实测。
