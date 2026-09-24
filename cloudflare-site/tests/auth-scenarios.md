# 史鉴上线前认证与共享数据检查

这份清单用于部署后验证。令牌只放在本地环境变量或密码管理器中，不要写入命令历史、网页、截图或仓库。

## 入口和代理

```powershell
$base = 'https://shijian-team-site-public.pages.dev'
Invoke-WebRequest "$base/" -MaximumRedirection 5
Invoke-WebRequest "$base/史鉴团队网站.html"
Invoke-WebRequest "$base/api/health"
```

`/` 应跳转到团队网站，`/api/health` 应返回 `ok: true`。Pages 的 `_worker.js` 应只代理 `/api/*` 到原 Worker，静态页面仍由 Pages 资产提供。

## 游客边界

以下请求不带任何团队或管理员身份，预期都应返回 `403`（健康检查除外）：

```powershell
Invoke-WebRequest "$base/api/feedback" -SkipHttpErrorCheck
Invoke-WebRequest "$base/api/v1/chat/completions" -Method Post `
  -ContentType 'application/json' -Body '{"messages":[{"role":"user","content":"test"}]}' `
  -SkipHttpErrorCheck
```

如果史料和系统提示词属于项目私有资料，`GET /api/sources` 与 `GET /api/settings` 也必须对游客返回 `403`，并在团队身份通过后才返回内容。当前 Worker 对这两个 GET 没有身份检查，这是上线前必须修正的权限问题。

## 三个成员共享

在本地安全终端中设置同一个团队邀请码：

```powershell
$team = '<从密码管理器粘贴，不要把真实值写进文件>'
$headers = @{ 'X-Team-Token' = $team }
```

成员 1 提交一条反馈，成员 2 用同一个令牌读取并修改其状态，成员 3 刷新后应看到同一条记录：

```powershell
$item = @{ id='auth-check-001'; createdAt=(Get-Date).ToUniversalTime().ToString('o'); author='成员1'; category='测试'; priority='P2'; title='共享检查'; status='新建' } | ConvertTo-Json
Invoke-WebRequest "$base/api/feedback" -Method Post -Headers $headers -ContentType 'application/json' -Body $item
Invoke-WebRequest "$base/api/feedback" -Headers $headers
```

验证完成后删除这条测试反馈，或在管理员页面清理。邀请码不应出现在 URL、日志或响应 JSON 中。

## 管理员边界

管理员令牌只能访问 `POST /api/settings` 和 `POST /api/sources`。团队邀请码访问这两个 POST 必须返回 `403`；游客也必须返回 `403`。管理员令牌不应作为团队令牌的长期替代品，否则泄露后会同时获得团队写权限。

## 登录、首次改密、退出（账号后端接入后）

账号服务确定 schema 后补充自动化测试。最低要求如下：

1. 登录成功只设置 `Secure; HttpOnly; SameSite=Lax` 会话 Cookie，响应体不返回密码、哈希或长期令牌。
2. 首次登录或临时密码登录必须强制改密；改密前访问反馈、史料和 AI 接口返回 `403`。
3. 改密成功立即轮换会话 Cookie，旧会话失效；密码不得回显在错误信息中。
4. 退出通过服务端撤销会话并发送 `Max-Age=0` 的同名 Cookie。退出后所有受保护接口返回 `401` 或 `403`。
5. Pages 代理必须保留请求的 `Cookie`，并原样传回受信任的 `Set-Cookie`；不能把 Cookie 值写入日志或转发到第三方 AI 上游。
6. 生产环境校验 `Origin`/`Referer`，配置明确的允许来源；跨域响应不能使用 `Access-Control-Allow-Origin: *` 搭配凭据。

## 发现的当前风险

- 现在的 Worker 是邀请码模式，没有账号、改密或退出接口；不要把它宣传成已完成账号系统。
- 当前 Pages 代理不主动删除 Cookie，但也没有账号后端可供 Cookie 会话使用。
- Worker 的 `isTeamMember` 接受管理员令牌作为恢复路径。若要求严格权限，应删除该回退或改成一次性、可审计的恢复流程。
- `/api/settings` 和 `/api/sources` 的 GET 当前公开；若内容不应公开，先补身份检查再上线正式史料。
