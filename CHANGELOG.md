# Changelog / 更新日志

All notable changes to DropRevive. Versions follow [Semantic Versioning](https://semver.org/); each production release gets a `vX.Y.Z` tag and a GitHub Release. Chinese first, then English.

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；每次正式发布都会打 `vX.Y.Z` 标签并发布 GitHub Release。

## [Unreleased]

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

[Unreleased]: https://github.com/TopCircle/DropRevive/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/TopCircle/DropRevive/releases/tag/v1.0.0
