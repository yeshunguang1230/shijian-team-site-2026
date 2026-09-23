# 史鉴公网 Worker 版

本目录是《史鉴团队网站》的 Cloudflare Workers + Workers Assets + D1 版本。它保留现有网页使用的 `/api/*` 接口，因此三个人打开同一个 `*.workers.dev` 地址即可看到同一份反馈和史料。

## 目录

- `public/`：只放需要公开的 5 个 HTML 页面，避免把 Python、数据库、课程文档和项目压缩包暴露到公网。
- `src/worker.js`：静态资源入口、反馈/史料 API、管理员接口和 OpenAI 兼容 AI 代理。
- `migrations/0001_initial.sql`：D1 表结构、演示系统提示词和 3 条待核验演示史料。
- `wrangler.json`：Worker、Assets 和 D1 绑定配置。创建 D1 后，把 `database_id` 替换为实际 ID。

## 部署步骤

在本目录执行：

```powershell
npx wrangler login
npx wrangler d1 create shijian-team-db
# 将命令输出的 database_id 写入 wrangler.json 的 database_id
npx wrangler d1 migrations apply shijian-team-db --remote
npx wrangler secret put SHIJIAN_ADMIN_TOKEN
npx wrangler secret put SHIJIAN_TEAM_TOKEN      # 三名成员共用的邀请码
npx wrangler secret put SHIJIAN_BASE_URL       # 可选：中转站 /v1 地址
npx wrangler secret put SHIJIAN_API_KEY       # 可选：AI 密钥
npx wrangler secret put SHIJIAN_MODEL         # 可选：模型名
npx wrangler deploy
```

`SHIJIAN_ADMIN_TOKEN` 用于 `史鉴云端管理.html` 保存系统提示词和史料，`SHIJIAN_TEAM_TOKEN` 用于团队成员读取/提交共享反馈和调用 AI；两者都不能写进 GitHub、网页或聊天记录。三个 AI 配置 secret 缺一项时网站仍可离线演示，AI 接口显示未配置。Cloudflare 的套餐额度、费用和账号身份验证要求以你的 Cloudflare 控制台实际提示为准；遇到支付验证时不要填写敏感支付信息，先停在该步骤确认方案。

## API 行为

- `GET /api/health`、`GET /api/config`：运行和 AI 配置状态。
- `GET /api/settings`、`GET /api/sources`：读取公开的规则和史料。
- `GET /api/feedback`、`POST /api/feedback`：必须带 `X-Team-Token`，写入/更新建议，同一个 `id` 幂等覆盖。
- `POST /api/settings`、`POST /api/sources`：必须 `X-Admin-Token`，供云端管理页保存。
- `POST /api/v1/chat/completions`：必须带 `X-Team-Token`，仅转发白名单字段，并有消息长度和每 IP 5 分钟 20 次限制；浏览器不会接触真实 AI 密钥。

## 验证

```powershell
npm install
npm run check
npx wrangler deploy --dry-run
```

`npm run check` 检查 Worker 语法、根路径跳转、健康检查和配置状态；`deploy --dry-run` 确认 Assets 与 D1 绑定均被识别。正式部署后用三台设备分别提交建议，刷新“团队建议中心”应看到同一条记录。
