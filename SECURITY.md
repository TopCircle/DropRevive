# Security policy / 安全策略

[English](#english) · [中文](#中文)

## English

### Reporting a vulnerability

Please report security problems **privately**. Do not open a public GitHub issue, pull request or discussion for them.

- Send a private message to the maintainers on Telegram: <https://t.me/droprevive>. Ask for a private chat if you reach the group first; do not post details in the group.
- Include what you found, how to reproduce it, and the impact you expect. Leave out real tokens, cookies or personal data.

We will acknowledge your report, keep you informed while we fix it, and credit you once a fix is live if you want credit.

### Scope

The production site https://drop.habor.dpdns.org and the code in this repository: the Worker routes under `/api/drive-auth` and `/api/transfer`, the LAN transfer rooms, and the browser app. Problems in Google Drive, OneDrive or Cloudflare themselves should go to those vendors.

Only the latest code on `main` (and the build marked by the `production` tag) is supported.

## 中文

### 报告漏洞

请**私下**报告安全问题，不要为此开公开的 GitHub issue、pull request 或讨论。

- 在 Telegram 上私信维护者：<https://t.me/droprevive>。如果先进了群，请要求私聊，不要在群里贴细节。
- 写清发现了什么、怎样复现、预计影响。不要附上真实的令牌、cookie 或个人数据。

我们会确认收到，修复过程中告知进展；修复上线后，如你愿意，会致谢署名。

### 范围

正式站 https://drop.habor.dpdns.org 和本仓库代码：`/api/drive-auth` 与 `/api/transfer` 下的 Worker 路由、局域网传送房间、浏览器端应用。Google Drive、OneDrive 或 Cloudflare 本身的问题请报告给对应厂商。

只支持 `main` 上的最新代码（以及 `production` 标签所指的构建）。
