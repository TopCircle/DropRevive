# 自己部署 DropRevive

[English](self-host.md) · [README](../README.zh-CN.md)

部署完成后，你会在自己的 Cloudflare 账号里拥有一份 DropRevive，用你自己的 OAuth 应用登录 Google Drive 和/或 OneDrive。Cloudflare 免费套餐就够用。整个过程大约 20–30 分钟，大部分时间花在 Google 和 Azure 控制台。

**总览**

1. 点按钮[部署](#1-部署)（约 2 分钟）。
2. 打开新站点的 `/setup`，复制回调地址。
3. 建 [Google](#google) 和/或 [OneDrive（Azure）](#onedrive) 应用。
4. 生成 [Cookie 密钥](#cookie-密钥)，设置[允许的站点地址](#允许的站点地址)。
5. 在 Cloudflare [填入 6 个值](#5-填入这些值)，刷新 `/setup` 直到显示「可以使用」。

只用一个网盘？跳过另一个网盘那一节，它的两项填 `none`。应用里那个网盘会显示「未开通」。

## 1. 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TopCircle/DropRevive)

1. 登录 Cloudflare，按提示连接你的 GitHub（或 GitLab）账号。
2. 仓库名和 Worker 名可以保留默认（`droprevive`），也可以改。
3. 表单应该列出 6 个密钥（来自 `.dev.vars.example`，说明写在 `package.json` 里），每项都必填。还没有值的就先填 `none`，第 5 步再改。有两项可以马上填：`DRIVE_COOKIE_KEY`（[生成方法](#cookie-密钥)）和 `ALLOWED_ORIGINS` = `https://<Worker 名>.<你的子域>.workers.dev`。构建命令 `npm run build`、部署命令 `npm run deploy` 应该会自动填好。如果构建那两栏是空的（部署命令是 `npx wrangler deploy`），不用改：`wrangler.jsonc` 会让直接跑的 `wrangler deploy` 先构建网站。
4. 点部署。Cloudflare 会在你的账号里建仓库、构建、创建两个 Durable Object（局域网直传房间和限流），然后部署。

**如果表单没有问这些密钥**，或者构建日志写着 `The following required secrets have not been set`：打开 Workers & Pages → 你的 Worker → **Settings → Variables and Secrets**，把 6 项都加上，类型选 **Secret**（不用的网盘填 `none`），然后到 **Deployments → Retry build** 重新构建（或随便 push 一个提交）。`wrangler.jsonc` 用 `secrets.required` 声明了这 6 项，缺任何一项时部署会直接拒绝，而不是上线一个登录不了的站点。

站点地址是 `https://<Worker 名>.<你的子域>.workers.dev`（子域在后台 Workers & Pages 页面能看到）。以后你往自己那份仓库 push，都会自动重新部署，密钥会保留。

不用按钮：clone 仓库，`npm ci`，`npx wrangler login`，把 `.dev.vars.example` 复制成 `.dev.vars` 并填好，再运行 `npm run deploy:self`（它会用 `wrangler deploy --secrets-file` 把 `.dev.vars` 作为 Worker 密钥一起上传）。

## 2. 打开 /setup

打开 `https://<你的站点>/setup`。它会逐项显示 6 个值是否已配置（不显示密钥的值）、Cookie 密钥是否有效、当前地址是否在 `ALLOWED_ORIGINS` 里，以及两个回调地址：

- Google：`https://<你的站点>/api/drive-auth/google/callback`
- Azure：`https://<你的站点>/api/drive-auth/microsoft/callback`

## Google

得到 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`。

1. 打开 <https://console.cloud.google.com/>，新建一个项目（名字随意）。
2. **API 和服务 → 库**，搜 **Google Drive API**，点**启用**。
3. **Google Auth Platform**（OAuth 同意屏幕）：
   - **品牌塑造**：应用名（例如「My DropRevive」）、支持邮箱、开发者联系邮箱。
   - **目标对象**：用户类型选**外部**。
   - **数据访问 → 添加或移除范围**：只加 `https://www.googleapis.com/auth/drive.file`。这是非敏感范围，应用只能看到它自己创建的文件。
4. **客户端 → 创建客户端**，类型选 **Web 应用**：
   - **已获授权的 JavaScript 来源**：`https://<你的站点>`
   - **已获授权的重定向 URI**：`/setup` 上的 Google 回调地址，一字不差。
   - 创建后复制**客户端 ID**（`….apps.googleusercontent.com`）→ `GOOGLE_CLIENT_ID`，**客户端密钥** → `GOOGLE_CLIENT_SECRET`。新版控制台的密钥只显示一次，记得保存。
5. **目标对象 → 发布应用**，状态改成**正式版**。留在**测试**状态时只有列出的测试用户能登录，而且登录大约 7 天就失效。

## OneDrive

得到 `MS_CLIENT_ID` 和 `MS_CLIENT_SECRET`。个人 Microsoft 账号和工作/学校账号都能用。

1. 打开 <https://portal.azure.com/> → **Microsoft Entra ID → 应用注册 → 新注册**。
   - 名称：随意。
   - 受支持的帐户类型：**任何组织目录中的帐户和个人 Microsoft 帐户**。
   - 重定向 URI：平台选 **Web**（不要选 SPA），填 `/setup` 上的 Azure 回调地址。
2. **概述**：复制**应用程序(客户端) ID** → `MS_CLIENT_ID`。
3. **证书和密码 → 客户端密码 → 新客户端密码**。选有效期（最长 24 个月）。复制**值**（不是「机密 ID」）→ `MS_CLIENT_SECRET`。只显示一次。
4. **API 权限 → 添加权限 → Microsoft Graph → 委托的权限**：`Files.ReadWrite`、`User.Read`、`offline_access`。个人账号不需要管理员同意；工作/学校租户可能需要。

## Cookie 密钥

`DRIVE_COOKIE_KEY` 用来加密存放刷新令牌的 cookie，必须是 32 个随机字节的 base64。生成一次，自己保管：

```bash
openssl rand -base64 32
```

或者在任意浏览器的开发者工具控制台里运行：

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

`/setup` 会检查它解码后是不是正好 32 字节，但不会显示它。以后换掉它，所有设备都会退出网盘登录（重新连接一次即可）。

## 允许的站点地址

`ALLOWED_ORIGINS` 列出这个 Worker 为哪些地址提供网盘登录和局域网配对：完整 origin，逗号分隔，不要带路径和结尾斜杠。例如：

```
https://droprevive.you.workers.dev,https://drop.example.com
```

没设置时，所有已部署的地址都会被拒绝（默认拒绝）。`/setup` 会告诉你当前打开的地址在不在列表里。

## 5. 填入这些值

Cloudflare 后台 → **Workers & Pages** → 你的 Worker → **Settings → Variables and Secrets**。逐个编辑这 6 项（类型选 **Secret**），保存/部署。立即生效，不用重新构建。也可以在终端里：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --name droprevive
```

刷新 `/setup`。显示**可以使用**后，打开站点，在设置里连接网盘。

| 密钥 | 来自 | 只用一个网盘？ |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google 客户端 | 不用 Google 填 `none` |
| `GOOGLE_CLIENT_SECRET` | Google 客户端 | 不用 Google 填 `none` |
| `MS_CLIENT_ID` | Azure 应用概述页 | 不用 OneDrive 填 `none` |
| `MS_CLIENT_SECRET` | Azure 客户端密码的「值」 | 不用 OneDrive 填 `none` |
| `DRIVE_COOKIE_KEY` | [自己生成](#cookie-密钥) | 必填 |
| `ALLOWED_ORIGINS` | 你的站点地址 | 必填 |

## 用自己的域名

1. 域名所在的 zone 要在你的 Cloudflare 账号里。Worker → **Settings → Domains & Routes → Add → Custom domain**，例如 `drop.example.com`。
2. 把 `https://drop.example.com` 加进 `ALLOWED_ORIGINS`（还在用 workers.dev 地址的话一起保留）。
3. 在新域名上打开 `/setup` 复制新的回调地址，加到 Google 客户端（连同 JavaScript 来源）和 Azure 应用里。
4. 可选：想只留自己的域名、彻底关掉 workers.dev，就改你那份仓库里的 `wrangler.jsonc`（`"workers_dev": false`，`"routes": [{ "pattern": "drop.example.com", "custom_domain": true }]`）再 push。否则下次构建会按文件把 workers.dev 重新打开。

## 日常维护

- **Azure 客户端密码会过期**（最长 24 个月）。提前一个月设个提醒：新建一个密码，更新 `MS_CLIENT_SECRET`，再删掉旧的。用户不会被登出。
- **Google 客户端密钥**：泄露时同样轮换（客户端 → 你的客户端 → 添加密钥）。
- **更新代码**：你的仓库是复制出来的，不是 fork。要同步上游：`git remote add upstream https://github.com/TopCircle/DropRevive && git pull upstream main && git push`，push 后自动重新部署。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 网盘显示「未开通」 | 这个网盘的 client ID 没设，看 `/setup` |
| `redirect_uri_mismatch`（Google）或 `AADSTS50011`（Azure） | 控制台里的回调地址和 `/setup` 显示的不一致（协议、域名、路径） |
| `origin_not_allowed`，登录或配对被拒 | 把当前地址加进 `ALLOWED_ORIGINS` |
| Google 登录一周后失效 | 同意屏幕还在测试状态，去发布 |
| 所有设备都被登出 | 换过 `DRIVE_COOKIE_KEY`，或客户端密钥过期了 |
| 构建日志：`Missing entry-point to Worker script or to assets directory` | `wrangler deploy` 之前没有构建网站（仓库是从旧版本复制的）。Workers & Pages → 你的 Worker → **Settings → Build**：**Deploy command（部署命令）** 改成 `npm run deploy`（它会构建、核对再部署；**Build command（构建命令）** 留空或填 `npm run build` 都行），保存后到 **Deployments → Retry build** 重新构建 |
