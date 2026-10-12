# 自己部署 DropRevive

[English](self-host.md) · [README](../README.zh-CN.md)

部署完成后，你会在自己的 Cloudflare 账号里拥有一份 DropRevive，用你自己的 OAuth 应用登录 Google Drive 和/或 OneDrive。Cloudflare 免费套餐就够用。整个过程大约 20–30 分钟，大部分时间花在 Google 和 Azure 控制台。

**先部署，再配置。** 部署不需要任何密钥：部署完网站就能打开，局域网直传就能用。网盘在你补上对应的值之后才开通。

1. 点按钮[部署](#1-部署)（约 2 分钟），什么都不用填。
2. 打开新站点的 `/setup`，复制回调地址。
3. 建 [Google](#google) 和/或 [OneDrive（Azure）](#onedrive) 应用。
4. 生成 [Cookie 密钥](#cookie-密钥)。
5. 在 Cloudflare [填入这些值](#5-填入这些值)，刷新 `/setup`，不用重新构建。

每一项都是可选的。一个网盘要同时有客户端 ID、客户端密钥和 `DRIVE_COOKIE_KEY` 才会开通，在那之前应用里显示「未开通」。只用一个网盘？跳过另一个网盘那一节，它的两项不填（或填 `none`）。`ALLOWED_ORIGINS` 也可以不设：不设时只允许站点自己的地址，workers.dev 地址和自定义域名都包括在内。

## 1. 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TopCircle/DropRevive)

1. 登录 Cloudflare，按提示连接你的 GitHub（或 GitLab）账号。
2. 仓库名和 Worker 名可以保留默认（`droprevive`），也可以改。
3. 构建设置保持原样。如果构建那两栏是空的（部署命令是 `npx wrangler deploy`），也没关系：`wrangler.jsonc` 会让直接跑的 `wrangler deploy` 先构建网站。这一步不会问密钥，部署完再加。
4. 点部署。Cloudflare 会在你的账号里建仓库、构建、创建两个 Durable Object（局域网直传房间和限流），然后部署。

站点地址是 `https://<Worker 名>.<你的子域>.workers.dev`（子域在后台 Workers & Pages 页面能看到）。以后你往自己那份仓库 push，都会自动重新部署，密钥会保留。

第一次一键部署后，如果 `workers.dev` 地址打不开，到 Workers & Pages → 你的 Worker → **Settings → Domains & Routes（域和路由）**，把 **workers.dev** 打开。Cloudflare 的一键部署流程可能在首次部署后把它关掉（部署本身已经开启过）；以后的部署会保持开启。

不用按钮：clone 仓库，`npm ci`，`npx wrangler login`，再运行 `npm run deploy:self`。已经有值的话，可以把 `.dev.vars.example` 复制成 `.dev.vars`，取消注释并填上，它会作为 Worker 密钥一起上传（`wrangler deploy --secrets-file`）。

## 2. 打开 /setup

打开 `https://<你的站点>/setup`。它会显示哪些网盘已开通，逐项显示 6 个值是否已配置（不显示密钥的值；没设的显示「未设置（可选）」）、Cookie 密钥是否有效、`ALLOWED_ORIGINS` 对当前地址的效果，以及两个回调地址：

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

两个网盘都要用它：没有有效的密钥（没设、填了 `none`、或不是 32 字节）时两个网盘都不开通，局域网直传不受影响。`/setup` 会检查它解码后是不是正好 32 字节，但不会显示它。以后换掉它，所有设备都会退出网盘登录（重新连接一次即可）。

## 允许的站点地址

可选。**不设（或填 `none`）**：只允许同源。页面只能在它自己被打开的地址上登录网盘、配对局域网，所以 workers.dev 地址和自定义域名什么都不用配就能用。`/setup` 会显示「未设置：仅同源（当前：<地址>）」。

**设了**：`ALLOWED_ORIGINS` 就是严格的名单，列出这个 Worker 为哪些地址提供网盘登录和局域网配对：完整 origin，逗号分隔，不要带路径和结尾斜杠。不在名单里的地址都会被拒绝，包括你正在用的这个。例如：

```
https://droprevive.you.workers.dev,https://drop.example.com
```

如果每一条格式都不对（比如 `drop.example.com` 少了 `https://`），就什么地址都不允许。这是故意的默认拒绝，免得写错一个字就悄悄放宽权限。`/setup` 会标出来，改正这些条目或者删掉这个变量即可。

## 5. 填入这些值

Cloudflare 后台 → **Workers & Pages** → 你的 Worker → **Settings → Variables and Secrets** → **Add**，类型选 **Secret**，保存/部署。只加你要用的。立即生效，不用重新构建。也可以在终端里：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --name droprevive
```

刷新 `/setup`。显示某个网盘「已开通」后，打开站点，在设置里连接它。

| 密钥 | 来自 | 用途 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google 客户端 | Google Drive（不设或 `none` = 不开 Google） |
| `GOOGLE_CLIENT_SECRET` | Google 客户端 | Google Drive |
| `MS_CLIENT_ID` | Azure 应用概述页 | OneDrive（不设或 `none` = 不开 OneDrive） |
| `MS_CLIENT_SECRET` | Azure 客户端密码的「值」 | OneDrive |
| `DRIVE_COOKIE_KEY` | [自己生成](#cookie-密钥) | 两个网盘都要 |
| `ALLOWED_ORIGINS` | 你的站点地址 | 可选：只有要允许别的地址时才设（[说明](#允许的站点地址)） |

### 可选：Cloudflare Secrets Store

想让**同一个 Cloudflare 账号**里的几个 Worker（比如正式站和测试站）共用网盘的值，可以把它们放进 [Secrets Store](https://developers.cloudflare.com/secrets-store/)（公开测试版：每个账号一个 store），不用每个 Worker 各填一遍。默认不启用，一键部署用不到它。

1. 后台 → **Secrets Store**，没有 store 就新建一个，复制它的 ID。
2. 新建这些密钥，权限范围（Permission scope）选 **Workers**（要在第 3 步之前建好：绑定一个不存在的密钥可能会让部署失败）：`DROP_GOOGLE_CLIENT_ID`、`DROP_GOOGLE_CLIENT_SECRET`、`DROP_MS_CLIENT_ID`、`DROP_MS_CLIENT_SECRET`、`DROP_DRIVE_COOKIE_KEY`。不用的网盘可以跳过。
3. Worker → **Settings → Build → Variables and secrets**（构建变量，不是 Worker 运行时的变量）：加 `DROP_SECRETS_STORE_ID` = store ID。想让某个 Worker 用自己的 Cookie 密钥，再设 `DROP_COOKIE_KEY_SECRET_NAME`（例如 `DROP_DRIVE_COOKIE_KEY_STAGING`）。然后 **Retry build** 或 push。用 `npm run deploy:self` 的话，在终端里设同样的变量。绑定只在设了这些变量的构建里才有：没设变量就构建或部署，部署出去的 Worker 没有 `SS_*` 绑定，网盘会改用 Worker 密钥（没有就关掉）。
4. 构建会绑定 `SS_GOOGLE_CLIENT_ID`、`SS_GOOGLE_CLIENT_SECRET`、`SS_MS_CLIENT_ID`、`SS_MS_CLIENT_SECRET` 和 `SS_DRIVE_COOKIE_KEY`。刷新 `/setup`：每一项都会显示来源（Secrets Store、Worker 密钥、构建时的值、未设置，或 Secrets Store 读取失败）。

Worker 先读 Secrets Store 的值；store 里的值是空的或 `none` 时，改用同名的 Worker 密钥；客户端 ID 再退一步，用构建时打进去的值（`VITE_GOOGLE_CLIENT_ID`、`VITE_MS_CLIENT_ID`，如果有）。读取顺序：Secrets Store → Worker 密钥 → 构建时的值。读取失败（密钥不存在、名字不对、权限范围没选 Workers）按未设置处理，对应的网盘会关着，直到修好。Store 的值会缓存约一分钟，所以换了值最多要等这么久才生效。`ALLOWED_ORIGINS` 仍然是 Worker 密钥（每个站点不一样）。部署时用的角色或 API 令牌要能绑定 Secrets Store 密钥（Super Administrator、Secrets Store Deployer，或 Account Secrets Store Edit）。

## 用自己的域名

1. 域名所在的 zone 要在你的 Cloudflare 账号里。Worker → **Settings → Domains & Routes → Add → Custom domain**，例如 `drop.example.com`。
2. 如果设了 `ALLOWED_ORIGINS`，把 `https://drop.example.com` 加进去（还在用 workers.dev 地址的话一起保留）。没设就不用管：新域名就是它自己的同源地址。
3. 在新域名上打开 `/setup` 复制新的回调地址，加到 Google 客户端（连同 JavaScript 来源）和 Azure 应用里。
4. 可选：想只留自己的域名、彻底关掉 workers.dev，就改你那份仓库里的 `wrangler.jsonc`（`"workers_dev": false`，`"routes": [{ "pattern": "drop.example.com", "custom_domain": true }]`）再 push。否则下次构建会按文件把 workers.dev 重新打开。

## 日常维护

- **Azure 客户端密码会过期**（最长 24 个月）。提前一个月设个提醒：新建一个密码，更新 `MS_CLIENT_SECRET`，再删掉旧的。用户不会被登出。
- **Google 客户端密钥**：泄露时同样轮换（客户端 → 你的客户端 → 添加密钥）。
- **更新代码**：你的仓库是复制出来的，不是 fork。要同步上游：`git remote add upstream https://github.com/TopCircle/DropRevive && git pull upstream main && git push`，push 后自动重新部署。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 第一次一键部署后 `workers.dev` 地址打不开 | Workers & Pages → 你的 Worker → **Settings → Domains & Routes（域和路由）**：打开 **workers.dev**。只需要这一次，以后的部署会保持开启 |
| 网盘显示「未开通」 | 它的客户端 ID、客户端密钥或 `DRIVE_COOKIE_KEY` 没设、是 `none` 或不对，看 `/setup` |
| 构建日志：`The following required secrets have not been set` | 你的仓库是从要求必填密钥的旧版本复制的。在 **Settings → Variables and Secrets** 把 6 项加上（暂时没有的填 `none`）再 **Retry build**，或者从上游更新你的仓库 |
| `redirect_uri_mismatch`（Google）或 `AADSTS50011`（Azure） | 控制台里的回调地址和 `/setup` 显示的不一致（协议、域名、路径） |
| `origin_not_allowed`，登录或配对被拒（创建局域网房间 403） | 设了 `ALLOWED_ORIGINS`，但名单里没有当前地址（或全是格式不对的条目）：把它加进去，或删掉这个变量改为仅同源 |
| Google 登录一周后失效 | 同意屏幕还在测试状态，去发布 |
| 所有设备都被登出 | 换过 `DRIVE_COOKIE_KEY`，或客户端密钥过期了 |
| 构建日志：`Missing entry-point to Worker script or to assets directory` | `wrangler deploy` 之前没有构建网站（仓库是从旧版本复制的）。Workers & Pages → 你的 Worker → **Settings → Build**：**Deploy command（部署命令）** 改成 `npm run deploy`（它会构建、核对再部署；**Build command（构建命令）** 留空或填 `npm run build` 都行），保存后到 **Deployments → Retry build** 重新构建 |
