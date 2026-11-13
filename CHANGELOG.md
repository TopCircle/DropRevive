# Changelog / 更新日志

All notable changes to DropRevive. Versions follow [Semantic Versioning](https://semver.org/); each production release gets a `vX.Y.Z` tag and a GitHub Release. Chinese first, then English.

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；每次正式发布都会打 `vX.Y.Z` 标签并发布 GitHub Release。

## [Unreleased]

### 中文
- **点对点直传改为边发边写、可续传**：两端都是新版本时，单文件和整批上限为 1 GB（Safari 512 MiB，iOS 256 MiB），用更大的分块和 8 字节偏移发送；发送端按 `File.slice` 读盘，接收端边收边写、不预分配整文件；同一页面 10 分钟内重连可从断点继续，并按文件做流式 SHA-256 校验。任一方仍是旧版本时，限额和协议保持原来的 32 / 64 MiB、最多 8 个文件，也不会向旧端发送新的 JSON。
- **云盘下载改为边下边存**：OneDrive 把临时下载链接交给浏览器，不再整文件读进内存。Google Drive 优先用「另存为」流式写入，否则通过本站 Service Worker 流式下载（令牌经 postMessage 传递，不放进网址）；Safari 与 iOS 不用这条 Service Worker 路径。超过约 32 MiB 的文件不再写入 IndexedDB，也不能在页面里整文件预览；在不能流式保存的浏览器里，大文件会提示换用 Chrome 或 Edge，或改从 OneDrive 下载。

### English
- **P2P transfer now streams to disk and can resume**: when both sides are current, the cap is 1 GB per file and per batch (512 MiB on Safari, 256 MiB on iOS), sent in larger frames with 8-byte offsets. The sender reads with `File.slice`; the receiver writes as bytes arrive and does not pre-allocate the file. A drop in the same tab can resume within 10 minutes, and each file is checked with a streaming SHA-256 digest. If either side is on the previous version, the original 32 / 64 MiB / 8-file caps and protocol stay in force, and no new JSON is sent to the old client.
- **Cloud downloads now stream to disk**: OneDrive hands its temporary download URL to the browser and no longer reads the whole file into memory. Google Drive prefers a “Save as” streaming write, then a same-origin Service Worker stream (token via postMessage, never in the URL); Safari and iOS skip that Service Worker path. Files over about 32 MiB are no longer written to IndexedDB and are not previewed as a whole-file Blob. Browsers that cannot stream a large Google file to disk show a prompt to use Chrome or Edge, or to download from OneDrive instead.

## [1.3.0] - 2026-11-12

已于 2026-11-12 部署到正式站。 / Deployed to the production site on 2026-11-12.

### 中文
- **云盘大文件上传更稳**：Google Drive（>5MB）和 OneDrive（>4MB）按约 8 MiB 分块顺序上传，失败后向服务端询问进度并从断点续传；只重试网络错误、5xx 和 429（最多 3 次，指数退避），单片有超时和无进度卡死检测。进度条按分块内实际上传量平滑前进，重传时不会退回 0。Google 大文件分块和 OneDrive 简单上传在 401 时会刷新令牌再试一次。用户可见的大小上限不变。刷新页面或取消后不能从断点恢复。云盘下载仍是整文件进入内存。
- 设置旁边的 Telegram 图标右侧新增 GitHub 图标，点开即可进入项目仓库。
- 文档已对齐上述行为，并补充正式站部署需在命令中内联 Secrets Store 变量、测试站部署需 `STAGING_WORKER`，以及实测的 lint 与测试数量。

### English
- **More reliable cloud uploads for large files**: Google Drive (>5 MB) and OneDrive (>4 MB) upload in sequential ~8 MiB chunks, query the server for progress after a failure, and resume from that offset. Only network errors, 5xx and 429 are retried (up to three attempts, exponential backoff), with a per-chunk timeout and stall watchdog. The progress bar follows in-chunk bytes and does not jump back to 0 on a retry. A 401 renews the access token and retries once on Google large-file chunks and OneDrive simple uploads. User-visible size limits are unchanged. An upload does not resume after a page refresh or a cancel. Cloud downloads still load the whole file into memory.
- A GitHub icon now sits to the right of the Telegram icon next to Settings and opens the project repository.
- Docs now match the above behaviour, and describe that a production deploy must inline the Secrets Store variables on the command, that a staging deploy needs `STAGING_WORKER`, and the measured lint and test counts.

## [1.2.0] - 2026-10-16

### 中文
- **粘贴并发送**：输入框旁新增按钮，一键读取剪贴板里的文字或图片并直接发出，云端收件箱和点对点直传都能用；点对点未连通时不显示。iPhone 的 Safari 每次都会弹出「粘贴」确认，这是系统限制。
- **收到的文字一键复制**：文字消息上直接显示「复制」；识别到验证码时显示「复制验证码 551203」，只复制验证码本身。单独一串 4–8 位字母数字（如「2026」）也会被当作验证码。
- **点对点诊断模式**：网址加 `?debug=1` 后，直传面板会显示连接日志、各 STUN 服务器连通情况和 NAT 类型提示，可「运行网络测试」并一键复制日志；不加参数时不显示、也不运行。
- 已知限制：两端之一处于对称 NAT（部分手机流量、多出口的公司网络）时，只靠 STUN 可能连不上；目前没有中继，可改用同一个 Wi-Fi 或云端收件箱。

### English
- **Paste & send**: a new button next to the composer reads text or an image from the clipboard and sends it at once, to the cloud inbox or over P2P (hidden while P2P is not connected). Safari on iPhone asks you to confirm the paste every time; that is a system limit.
- **One-tap copy on received text**: text messages show a Copy button; when a one-time code is found it shows "Copy code 551203" and copies just the code. A bare 4–8 character letters-and-digits string (like "2026") also counts as a code.
- **P2P diagnostics**: add `?debug=1` to the URL to see the connection log, per-STUN-server reachability and a NAT hint in the transfer panel, with "Run network test" and one-tap "Copy log"; without the flag nothing is shown or run.
- Known limit: when either side is behind a symmetric NAT (some mobile data, multi-exit company networks), STUN alone may not connect; there is still no relay, so use the same Wi-Fi or the cloud inbox.

## [1.1.0] - 2026-10-14

### 中文
- **「局域网直传」改名为「点对点直传」**：不同网络下也能直连，同一个 Wi-Fi 下最稳；网址和内部名称不变。
- **直传支持公共 STUN**（Cloudflare、Google，以及国内的 bilibili、hitv），不同网络下多数情况也能点对点直连；STUN 只看到公网 IP，看不到文件内容；仍然没有 TURN、没有中继。
- 连不上时的提示说明了原因（运营商大内网、公司或访客 Wi-Fi），并建议连同一个 Wi-Fi。
- 直传界面更清楚：连接中显示「正在建立直连…」，连通后才出现发送按钮；直连失败会很快告知双方原因，可「重新开始」或改用云端收件箱；最长等待 20 秒。
- 手机侧栏底部按钮不再换行；英文界面统一使用「Privacy Policy」，输入框提示改为「Type, or drop files here」。
- 依赖更新（setup-node、lucide-react、globals、eslint-plugin-react-hooks 7），移除未使用的 react-day-picker；README 致谢 LINUX DO。

### English
- **"LAN transfer" is now "P2P Transfer"**: it can connect across networks and works best on the same Wi-Fi; URLs and internal names are unchanged.
- **Direct transfer uses public STUN** (Cloudflare, Google, plus bilibili and hitv for mainland China), so peers on different networks can usually connect P2P; STUN sees only public IPs, never file content; still no TURN and no relay.
- The connection-failed message now explains why (carrier-grade NAT, corporate or guest Wi-Fi) and suggests the same Wi-Fi.
- Clearer direct-transfer states: "Connecting…" until the link is up, and the send button only appears once connected; a failed link quickly tells both sides why, with Start over or Use cloud inbox; capped at 20 s.
- Mobile sidebar footer buttons no longer wrap; English settings say "Privacy Policy" consistently, and the composer placeholder is now "Type, or drop files here".
- Dependency updates (setup-node, lucide-react, globals, eslint-plugin-react-hooks 7); removed unused react-day-picker; README thanks LINUX DO.

## [1.0.0] - 2026-10-13

首个正式版本，即线上 `bc589f5` 的代码（v1.0.0 标签）。 / First release; the code production runs at `bc589f5` (tag v1.0.0).

### 中文
- **网盘收件箱**：文字和文件存进你自己 Google Drive / OneDrive 的 `DropRevive` 文件夹，浏览器直连网盘，服务器不保存文件；后台同步、「立即同步」、已同步内容可离线查看。
- **局域网直传（WebRTC）**：二维码或 8 位码配对，文件直达对方设备，无中继。单文件 32 MiB、单批 64 MiB、文字 32 KiB。会话在站内切换页面时保持，只在「断开」、关闭标签页或对方离开时结束；网络短暂中断自动重连（退避），最长 10 分钟；导航角标与提示；未保存文件在断开前提醒，超过 128 MiB 时警告。
- **PWA**：可安装；中英文；浅色 / 深色 / 跟随系统。
- **一键部署到 Cloudflare**：先部署、后配置，部署不需要密钥；网盘在 Client ID、Client Secret 和 `DRIVE_COOKIE_KEY` 都设置后开启；`/setup` 检查页；`ALLOWED_ORIGINS` 可选，默认同源。
- **可选 Secrets Store**：构建变量 `DROP_SECRETS_STORE_ID`，读取顺序 Store → Worker secret → 构建值。
- **安全**：Google 只用 `drive.file`；刷新令牌只在加密的 HttpOnly Cookie 中。漏洞请私密报告（见 SECURITY.md）。
- **已知限制**：手机后台标签页可能暂停 WebRTC，传输时保持前台；部分网络会挡住直连，请改用网盘。

### English
- **Cloud drive inbox**: text and files go to the `DropRevive` folder in your own Google Drive / OneDrive; the browser talks to the drive directly and the server stores no files; background sync, "Sync now", offline viewing of synced items.
- **LAN direct transfer (WebRTC)**: pair by QR or 8-character code; files go device to device with no relay. 32 MiB per file, 64 MiB per batch, 32 KiB of text. The session survives in-app navigation and ends only on Disconnect, tab close, or when the peer leaves; transient drops reconnect automatically with backoff for up to 10 minutes; nav badge and toasts; warnings before dropping unsaved files and above 128 MiB unsaved.
- **PWA**: installable; Chinese and English; light / dark / system theme.
- **One-click Cloudflare deploy**: deploy first, configure later, no secrets needed; a drive turns on once its client ID, client secret and `DRIVE_COOKIE_KEY` are set; `/setup` check page; `ALLOWED_ORIGINS` optional, same-origin by default.
- **Optional Secrets Store**: build variable `DROP_SECRETS_STORE_ID`; read order Store → Worker secret → build value.
- **Security**: Google uses only `drive.file`; refresh tokens live only in encrypted HttpOnly cookies. Report vulnerabilities privately (see SECURITY.md).
- **Known limitations**: mobile background tabs may suspend WebRTC, so keep the page in front while transferring; some networks block the direct link, so use the cloud inbox.

[Unreleased]: https://github.com/TopCircle/DropRevive/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/TopCircle/DropRevive/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/TopCircle/DropRevive/releases/tag/v1.2.0
[1.1.0]: https://github.com/TopCircle/DropRevive/releases/tag/v1.1.0
[1.0.0]: https://github.com/TopCircle/DropRevive/releases/tag/v1.0.0
