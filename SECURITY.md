# Security policy / 安全策略

[English](#english) · [中文](#中文)

## English

### Reporting a vulnerability

Please report security problems **privately**. Do not open a public GitHub issue, pull request or discussion for them.

- Use GitHub's private vulnerability reporting: open the repository's **Security** tab and click **Report a vulnerability** (<https://github.com/TopCircle/DropRevive/security/advisories/new>). Only the maintainers can see the report.
- **Never post a vulnerability in the Telegram group** (<https://t.me/droprevive>). The group is public; use it only for non-sensitive questions.
- Include what you found, how to reproduce it, and the impact you expect. Leave out real tokens, cookies or personal data.

We will acknowledge your report, keep you informed while we fix it, and credit you once a fix is live if you want credit.

### Scope

The production site https://drop.habor.dpdns.org and the code in this repository: the Worker routes under `/api/drive-auth` and `/api/transfer`, the P2P Transfer rooms, and the browser app. Problems in Google Drive, OneDrive or Cloudflare themselves should go to those vendors.

Only the latest code on `main` (and the build marked by the `production` tag) is supported.

## 中文

### 报告漏洞

请**私下**报告安全问题，不要为此开公开的 GitHub issue、pull request 或讨论。

- 用 GitHub 的私密漏洞报告：打开仓库的 **Security** 标签页，点 **Report a vulnerability**（<https://github.com/TopCircle/DropRevive/security/advisories/new>）。报告只有维护者能看到。
- **不要把漏洞发到 Telegram 群**（<https://t.me/droprevive>）。群是公开的，只用来问不涉及安全的问题。
- 写清发现了什么、怎样复现、预计影响。不要附上真实的令牌、cookie 或个人数据。

我们会确认收到，修复过程中告知进展；修复上线后，如你愿意，会致谢署名。

### 范围

正式站 https://drop.habor.dpdns.org 和本仓库代码：`/api/drive-auth` 与 `/api/transfer` 下的 Worker 路由、点对点直传房间、浏览器端应用。Google Drive、OneDrive 或 Cloudflare 本身的问题请报告给对应厂商。

只支持 `main` 上的最新代码（以及 `production` 标签所指的构建）。
