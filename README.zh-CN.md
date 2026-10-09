# DropRevive

[English](README.md)

在自己的设备之间传送文字和文件。需要登录你自己的 Google Drive 或 OneDrive，内容保存在这个网盘的 `DropRevive` 文件夹里。浏览器直接把文件交给网盘。项目的服务器只提供网页，不保存文件，也不生成给其他人打开的链接。

对方稍后才打开时，登录同一个网盘账号并同步，就能看到同一批云端记录。两台设备都在身边时，可以用临时直传，文件不经过网盘。没有多人房间，也没有匿名分享链接。

DropRevive 是独立项目，用来补 Edge Drop 停用之后的同类需求。它与 Microsoft Edge、微软、Google 没有从属或合作关系。

线上试用：<https://drop.habor.dpdns.org>

许可证（License）：[MIT](LICENSE)

## 给使用者

1. 打开网站，在设置里连接 Google Drive 或 OneDrive，也可以两个都连。
2. 写下文字，或放入文件，投送到网盘里的 `DropRevive` 文件夹。侧边栏里的文件夹是这个目录下的子文件夹。
3. 在另一台设备上用同一个网盘账号打开，等同步完成。

设备在身边、两边都打开 DropRevive 时，用临时直传。配对用二维码或 8 位代码。文件直接到对方设备，不进 `DropRevive` 网盘文件夹。对方稍后才打开时，用云端收件箱。

**用手机扫二维码。** 页面内的扫码器在浏览器有 `BarcodeDetector` 时优先用它；没有、报错，或者几秒内一直读不出东西时，改用按需加载的 jsQR 解码。`BarcodeDetector` 可能存在却不好用（例如没有 Google 服务的安卓浏览器），所以兜底并不只在它缺失时才启用。摄像头请求 1280x720、30 帧；浏览器支持时开启连续对焦、点击取景框对焦，摄像头带闪光灯时显示手电筒按钮。取景框铺满面板宽度。出问题（没给权限、没有摄像头、扫到别的站点的码、10 秒什么都没读到）只用简短的 toast 提示，不会在画面上盖文字。随时可以改为手动输入 8 位代码。想看某台设备上扫码器的实际状态，用 `?scandebug=1` 打开站点（见[参与开发](CONTRIBUTING.md)）。

配对时要能访问站点。传文件时不经过 Worker。没有局域网自动发现，也没有服务器中继。连不上时改用云端。单文件最大 32 MiB，整批最大 64 MiB，文字最大 32 KiB。传输时保持页面在前台。传完后逐个点击保存。

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

`npm run deploy` 用于部署你自己的站点。`npm run deploy:production` 仅供维护者使用；它会写入正式站的公开 client ID，并部署到 `wrangler.jsonc` 指定的域名。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发，<http://localhost:8080>。环境里没有 client ID 时，网盘显示「未开通」 |
| `npm run build` | 按当前环境变量做生产构建，输出到 `.output/` |
| `npm run deploy` | 部署到你自己的 Cloudflare 账号。会先检查 `wrangler.jsonc`：Worker 仍叫 `dropreceive`、路由仍指向 `drop.habor.dpdns.org`，或者没有设置路由时，在构建之前就拒绝执行 |
| `npm run deploy:production` | 仅维护者。替换正式环境 Worker `dropreceive` |

自己部署并开通连接：

1. 把 `wrangler.jsonc` 的 `routes` 改成你的域名，并把 Worker 名 `dropreceive` 改成你自己的（例如 `my-droprevive`），`workers_dev` 保持 false。两样都改好之前，`npm run deploy` 会拒绝执行。
2. 在 Google Cloud 建一个网页 OAuth 客户端。授权回调填 `https://你的域名/api/drive-auth/google/callback`。范围使用 `drive.file`。同意屏幕需要离线访问，这样才会发刷新令牌。
3. 在 Azure 建一个 Web 平台注册，不要用 SPA。回调填 `https://你的域名/api/drive-auth/microsoft/callback`。范围是 `User.Read`、`Files.ReadWrite`、`offline_access`。authority 使用 `common`。给这个应用建一个客户端密钥。
4. 构建或部署前设置你自己的 `VITE_GOOGLE_CLIENT_ID` 和 `VITE_MS_CLIENT_ID`。两个都可以留空：站点能打开，对应网盘显示「未开通」。这两个是公开的 client ID（构建时环境变量），不是 Worker 密钥。
5. 用 `npx wrangler secret put <NAME> --name <worker>` 写入 Worker 密钥（从标准输入传入；不要写进文件，也不要放进 `wrangler.jsonc` 的 `vars`）：

   | 密钥 | 用途 | 格式 / 示例 |
   | --- | --- | --- |
   | `ALLOWED_ORIGINS` | 允许网盘登录和局域网配对的来源 | 逗号分隔的完整 origin，例如 `https://你的域名`（不要带路径）。缺失或为空时拒绝已部署的主机（默认拒绝）。`http://localhost:8080` 仅对本机 `npm run dev` 始终放行。 |
   | `GOOGLE_CLIENT_SECRET` | Google OAuth 客户端密钥 | 来自 Google Cloud 控制台 |
   | `MS_CLIENT_SECRET` | Microsoft OAuth 客户端密钥 | 来自 Azure 应用注册 |
   | `DRIVE_COOKIE_KEY` | 刷新令牌 cookie 的 AES-GCM 密钥 | 32 随机字节的 base64（例如 `openssl rand -base64 32`） |

   示例：`printf '%s' 'https://你的域名' | npx wrangler secret put ALLOWED_ORIGINS --name my-droprevive`
6. `npx wrangler login` 登录你自己的 Cloudflare 账号，然后运行 `npm run deploy`。

本机要做真实登录时，把 `http://localhost:8080/api/drive-auth/google/callback` 和 `http://localhost:8080/api/drive-auth/microsoft/callback` 登记到这两个控制台，再带上两个 client ID 和三个 OAuth/cookie 密钥运行 `npm run dev`。本机可不设 `ALLOWED_ORIGINS`（`http://localhost:8080` 已内置）。`127.0.0.1:8081` 不在允许的来源里。

维护者那套 client ID 只登记了 `https://drop.habor.dpdns.org`。换域名之后不能靠它们完成登录。

## 开发

- [参与开发](CONTRIBUTING.md) · [架构说明](docs/architecture.zh-CN.md)（[English](docs/architecture.md)）· [安全策略](SECURITY.md)
- GitHub Actions 会在 push 和 pull request 时运行类型检查、测试、lint 和构建；CI 不使用部署密钥。
- `npm test` 先跑脚本测试，再跑单元和集成测试：传送协议和局域网房间、扫码辅助逻辑、网盘登录经纪、跨标签页续签，以及网盘 store（同步、删除、令牌过期）。写这段时共有 10 个脚本测试加 264 个其他测试；lint 保持 0 error、0 warning。
- 交流和提问：项目的 Telegram 群组 <https://t.me/droprevive>。安全问题请私下报告，见 [SECURITY.md](SECURITY.md)。
- `npm run deploy` 会运行带域名保护的自建部署。`npm run deploy:production` 才是维护者更新 `drop.habor.dpdns.org` 正式站的专用命令。

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
npm run deploy          # 自建部署；配置仍指向维护者域名时会拒绝
npm run deploy:production # 只更新 https://drop.habor.dpdns.org
npm run deploy:staging  # 维护者用：只更新私有测试站 Worker（地址不公开）
```
