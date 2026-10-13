# DropRevive

[English](README.md)

在自己的设备之间传送文字和文件。需要登录你自己的 Google Drive 或 OneDrive，内容保存在这个网盘的 `DropRevive` 文件夹里。浏览器直接把文件交给网盘。项目的服务器只提供网页，不保存文件，也不生成给其他人打开的链接。

对方稍后才打开时，登录同一个网盘账号并同步，就能看到同一批云端记录。两台设备都在身边时，可以用临时直传，文件不经过网盘。没有多人房间，也没有匿名分享链接。

DropRevive 是独立项目，用来补 Edge Drop 停用之后的同类需求。它与 Microsoft Edge、微软、Google 没有从属或合作关系。

线上试用：<https://drop.habor.dpdns.org> · 自己部署：[一键部署到 Cloudflare](#给自己部署的人)

许可证（License）：[MIT](LICENSE)

## 给使用者

1. 打开网站，在设置里连接 Google Drive 或 OneDrive，也可以两个都连。
2. 写下文字，或放入文件，投送到网盘里的 `DropRevive` 文件夹。侧边栏里的文件夹是这个目录下的子文件夹。
3. 在另一台设备上用同一个网盘账号打开，等同步完成。

设备在身边、两边都打开 DropRevive 时，用临时直传。配对用二维码或 8 位代码。文件直接到对方设备，不进 `DropRevive` 网盘文件夹。对方稍后才打开时，用云端收件箱。

**用手机扫二维码。** 页面内的扫码器在浏览器有 `BarcodeDetector` 时优先用它；没有、报错，或者几秒内一直读不出东西时，改用按需加载的 jsQR 解码。`BarcodeDetector` 可能存在却不好用（例如没有 Google 服务的安卓浏览器），所以兜底并不只在它缺失时才启用。摄像头请求 1280x720、30 帧；浏览器支持时开启连续对焦、点击取景框对焦，摄像头带闪光灯时显示手电筒按钮。取景框铺满面板宽度。出问题（没给权限、没有摄像头、扫到别的站点的码、10 秒什么都没读到）只用简短的 toast 提示，不会在画面上盖文字。随时可以改为手动输入 8 位代码。想看某台设备上扫码器的实际状态，用 `?scandebug=1` 打开站点（见[参与开发](CONTRIBUTING.md)）。

配对时要能访问站点。传文件时不经过 Worker。没有局域网自动发现，也没有服务器中继。连不上时改用云端。单文件最大 32 MiB，整批最大 64 MiB，文字最大 32 KiB。传完后逐个点击保存。

会话属于浏览器标签页，不属于局域网直传页面：可以切到收件箱、网盘或设置，回来时仍然连着。局域网直传页面没打开时，导航里的「局域网直传」会显示绿点（已连接）和待处理数量（待接收的发送、没保存的文件），新的发送和收到的文件会弹出提示；对方发来的内容一律等你点接收。只有三种情况会结束会话：点「断开」、关掉标签页、对方离开：

- **主动离开**（点断开或关标签页）会发出 bye，两边立刻回到初始界面。自己还有没保存的文件时，断开前会先确认；**对方**离开时，没保存的文件会留下（连同所在那一批），并给出提示。
- **网络中断**（没有 bye）：显示「重连中」并自动重试，间隔从 1 秒逐步加到 30 秒，最多 10 分钟；服务器上的房间会为这段时间保留。10 分钟还没连回来，就当对方已离开，清空会话，没保存的文件仍保留。
- 收到的文件保存在标签页内存里，直到保存或「移除」；没保存的超过 128 MiB 时提醒一次。时间线最多保留最近 200 条（没保存的、进行中的不会被删）。
- 手机可能暂停或结束后台标签页和它的 WebRTC 连接。短暂切走，回来时会恢复；切走太久可能结束会话。手机上传输时请保持页面打开。

现在能做的事：

- 发送文字和文件，并从任一已连接的网盘下载、预览、筛选。
- 后台同步，以及手动「立即同步」。列表不完整时，已有的本地历史会保留。
- 中文和英文、浅色 / 深色 / 跟随系统、设备名。
- 安装到桌面（PWA）。安装后的图标和浏览器标签图标是两套图。
- 断网时查看这台设备已经同步过的记录。
- 设置旁边有一个 Telegram 图标（隐私说明页里也有链接），点开就是项目的 Telegram 群组。

断网时的新内容不会排队。投送会直接失败，也不会写入本机历史。删除同样要等网络恢复后再做。清除本机缓存之后，云端文件仍在网盘里；在应用里删除一条记录时，对应文件才会从网盘移除。

### 连接时实际授权的范围

设置里，每个连接按钮上方都有一段说明。

| 网盘 | 同意屏幕上的范围 | 应用实际怎么用 |
| --- | --- | --- |
| Google Drive | `drive.file` | 只能访问本应用创建或打开过的文件，也就是 `DropRevive` 文件夹 |
| OneDrive | `Files.ReadWrite`，加上 `User.Read` 和 `offline_access` | 同意范围覆盖整个 OneDrive。应用只读写其中的 `DropRevive` 文件夹，并保持登录 |

OneDrive 目前没有一个更窄的范围能保持现在的用法。`Files.ReadWrite.AppFolder` 只能进入应用的特殊目录，进不了网盘根目录下这个同名文件夹。`Files.ReadWrite.Selected` 要求用户逐个挑选文件，应用就不能自己创建文件夹并同步。所以 OneDrive 的同意屏幕仍会请求整个网盘的读写权限。

### 本机保存了什么

| 位置 | 键或库 | 内容 |
| --- | --- | --- |
| IndexedDB `droprevive` | `items`、`blobs`、`kv` | 历史缓存、文件缓存，以及下面那把加密密钥 |
| localStorage | `droprevive.settings` | 主题、设备名 |
| localStorage | `droprevive.folders`、`droprevive.shelves` | 网盘上的目录 ID、侧边栏文件夹 |
| localStorage | `droprevive.locale` | 界面语言；同名 cookie 给离线页使用 |
| localStorage | `droprevive.tokens` | 密封后的访问令牌，用来在刷新后恢复「已连接」。刷新令牌不在这里 |
| localStorage | `droprevive.outbox` | 同步时会重放其中还没删掉的云端引用。当前的删除操作不再往这里追加；删不掉的记录留在历史里 |
| Cookie | `__Secure-dr-g`、`__Secure-dr-m` | 加密后的刷新令牌，HttpOnly，只发给 `/api/drive-auth` |

`droprevive.tokens` 用 AES-GCM 密封后再写入 localStorage，密钥放在同一站点的 IndexedDB 里，并且不可导出。里面是访问令牌，大约一小时过期。刷新令牌只在 HttpOnly cookie 里，浏览器脚本读不到。能在这个网站里运行的脚本，包括一旦出现的 XSS，仍然可以解密并使用访问令牌，也能请 Worker 续签。这层加密阻挡的是直接查看 localStorage，不是站点里的脚本。

界面语言没有保存过时：浏览器语言以 `zh` 开头用中文，以 `en` 开头用英文，其余用中文。

## 给自己部署的人

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TopCircle/DropRevive)

点这个按钮，Cloudflare 会把本仓库复制到你的 GitHub 账号，用 Workers Builds 构建，并在 `workers.dev` 上部署一个名为 `droprevive` 的 Worker（带两个 Durable Object）。之后你往自己那份仓库 push，都会自动重新部署。先部署，再配置：部署时不问任何密钥，网站和局域网直传马上就能用；网盘在补上对应的值之后开通：

1. 打开 `https://droprevive.<你的子域>.workers.dev/setup`。这页显示哪些网盘已开通，列出 6 个可选的 Worker 密钥是否已设置（不显示值），检查 Cookie 密钥是否有效、`ALLOWED_ORIGINS` 对当前地址的效果，并给出要登记的回调地址。
2. 用这两个回调地址建 Google OAuth 客户端和/或 Azure 应用。只用一个网盘也可以：另一个网盘的两项不填（或填 `none`）。
3. 把已有的值填到 Cloudflare 后台 Workers → 你的 Worker → Settings → Variables and Secrets（或 `npx wrangler secret put NAME`）。保存即生效，不用重新构建；刷新 `/setup`，直到显示你的网盘「已开通」。

第一次一键部署后，如果 `https://droprevive.<你的子域>.workers.dev` 打不开，到 Workers → 你的 Worker → Settings → Domains & Routes（域和路由），把 workers.dev 打开（Cloudflare 的一键部署流程可能在首次部署后把它关掉）；以后的部署会保持开启。

详细步骤（含自定义域名、密钥轮换）：[docs/self-host.zh-CN.md](docs/self-host.zh-CN.md)（[English](docs/self-host.md)）。

全部可选。一个网盘要同时有客户端 ID、客户端密钥和 `DRIVE_COOKIE_KEY` 才会开通（不设或 `none` = 不开通）；局域网直传一项都不需要。

| Worker 密钥 | 是什么 | 说明 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth 客户端 ID | 公开值。不用 Google Drive 就不设 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 客户端密钥 | 不用 Google Drive 就不设 |
| `MS_CLIENT_ID` | Azure 应用（客户端）ID | 公开值。不用 OneDrive 就不设 |
| `MS_CLIENT_SECRET` | Azure 客户端密钥的「值」 | 最长 24 个月到期。不用 OneDrive 就不设 |
| `DRIVE_COOKIE_KEY` | 刷新令牌 cookie 的 AES-GCM 密钥 | 32 随机字节的 base64：`openssl rand -base64 32`。两个网盘都要用 |
| `ALLOWED_ORIGINS` | 允许网盘登录和局域网配对的站点地址 | 可选。不设或 `none`：只允许同源（站点自己的地址，workers.dev 或自定义域名）。设了：严格名单，逗号分隔，例如 `https://droprevive.you.workers.dev,https://drop.example.com`。全是格式不对的条目时一律拒绝 |

想在同一个 Cloudflare 账号的几个 Worker 之间共用这些值？设构建变量 `DROP_SECRETS_STORE_ID`，把值放进 Cloudflare Secrets Store，见[指南里的 Secrets Store 一节](docs/self-host.zh-CN.md#可选cloudflare-secrets-store)。默认不启用。

这份清单也在 [`.dev.vars.example`](.dev.vars.example) 里，那是本机开发用的模板，每一行都注释掉了。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发，<http://localhost:8080>（只监听本机；局域网访问用 `HOST=0.0.0.0 npm run dev`）。6 项设置从环境变量读取；没有 client ID 时网盘显示「未开通」 |
| `npm run build` | 按公开配置构建到 `.output/`（Worker `droprevive`，`workers.dev`，无路由） |
| `npm run deploy` | 先构建，再核对构建是公开配置（workers.dev 开启、无路由、不叫 `dropreceive`），再 `wrangler deploy`。部署按钮跑的就是它；它自己会先构建，所以后台构建命令为空也能部署。不需要任何密钥 |
| `npm run deploy:self` | 在自己电脑上构建并部署。Worker 仍叫 `dropreceive`，或路由指向 `drop.habor.dpdns.org` 时拒绝；只用 `workers.dev` 或用你自己的域名都可以 |
| `npm run deploy:production` | 仅维护者：按正式站配置构建（`DROP_PROFILE=production`，Worker `dropreceive`，自定义域名 `drop.habor.dpdns.org`），部署前核对生成的配置 |

不用按钮：fork 或 clone，`npx wrangler login`，`npm ci`，再运行 `npm run deploy:self`。已经有值的话，可以把 `.dev.vars.example` 复制成 `.dev.vars`，取消注释并填上，会作为 Worker 密钥一起上传。

从旧版本复制的仓库可能仍然报 `The following required secrets have not been set`：到 Worker → Settings → Variables and Secrets 把 6 项加上（暂时没有的填 `none`）再重新构建，或者从上游更新你的仓库。

本机要做真实登录时，把 `http://localhost:8080/api/drive-auth/google/callback` 和 `http://localhost:8080/api/drive-auth/microsoft/callback` 登记到两个控制台，再带着这些设置的环境变量运行 `npm run dev`。本机可不设 `ALLOWED_ORIGINS`（`http://localhost:8080` 已内置）。

维护者那套 client ID 只登记了 `https://drop.habor.dpdns.org`。换域名之后不能靠它们完成登录。

## 开发

- [参与开发](CONTRIBUTING.md) · [架构说明](docs/architecture.zh-CN.md)（[English](docs/architecture.md)）· [安全策略](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)
- GitHub Actions 会在 push 和 pull request 时运行类型检查、测试、lint 和构建；CI 不使用部署密钥。
- `npm test` 先跑脚本测试，再跑单元和集成测试：传送协议和局域网房间、扫码辅助逻辑、网盘登录经纪、跨标签页续签，以及网盘 store（同步、删除、令牌过期）。写这段时共有 37 个脚本测试加 323 个其他测试；lint 保持 0 error（react-hooks 的 `refs` 和 `set-state-in-effect` 两条规则暂时为 warning，之后修复）。
- 交流和提问：项目的 Telegram 群组 <https://t.me/droprevive>。安全问题请私下报告，见 [SECURITY.md](SECURITY.md)。
- `wrangler.jsonc` 是公开配置。正式站是 `scripts/wrangler-profile.mjs` 里的一个构建配置；`npm test` 会检查公开、正式、测试站三套配置生成得对不对。

备注：

- 文案在 `src/lib/i18n/`。中文包定义键，其他语言包必须覆盖同一组键，再在 `src/lib/i18n/index.ts` 里用 `registerPack` 注册。
- `wrangler.jsonc` 的 `compatibility_date` 为 `2026-09-26`，启用 `nodejs_compat`，不写 `main` / `assets`：构建会把最终配置写到 `.output/server/wrangler.json`。
- 每次生产部署都打 `production` 标签，标签指向线上运行的源码。
- PWA 清单是静态的 `public/manifest.webmanifest`（图标在 `public/icons/`，分享目标 `/share`）；`public/sw.js` 是 Service Worker。项目没有账号系统和数据库。

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
npm run deploy          # 构建、核对公开配置，再 wrangler deploy（部署按钮跑的就是它）
npm run deploy:self     # 构建并部署你自己的副本；拒绝维护者的 Worker 和域名
npm run deploy:production # 只更新 https://drop.habor.dpdns.org
STAGING_WORKER=<名字> npm run deploy:staging  # 维护者用：部署到 workers.dev 上的测试 Worker；没设 STAGING_WORKER 会拒绝
```

用了 Secrets Store？每个 `deploy*` 脚本都会重新构建，所以先在同一个终端里 export `DROP_SECRETS_STORE_ID`（Worker 用自己的 Cookie 密钥时再加 `DROP_COOKIE_KEY_SECRET_NAME`）。没设的话，部署出去就没有 Store 绑定。

## 致谢

感谢 [LINUX DO](https://linux.do) 社区。
