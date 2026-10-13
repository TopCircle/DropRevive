# Contributing / 参与开发

[English](#english) · [中文](#中文)

## English

### Setup

Use Node.js 22 (LTS). Install exactly what the lockfile pins:

```bash
npm ci
```

### Everyday commands

```bash
npm run dev        # dev server on http://localhost:8080 (localhost only; HOST=0.0.0.0 npm run dev to expose it on your LAN)
npm test           # unit and integration tests (node --test)
npm run lint       # ESLint; must report 0 errors
npm run typecheck  # tsc --noEmit
npm run build      # production build into .output/
```

CI (GitHub Actions) runs `npm ci`, typecheck, test, lint and build on every push and pull request. Run the same commands locally before you open a pull request. Lint is kept at 0 errors and 0 warnings. At the time of writing `npm test` runs 37 script tests plus 323 unit and integration tests.

### Testing on a phone

Camera and focus behaviour cannot be checked in a desktop browser, so try LAN pairing on a real phone against a deployed Worker (a test site exists for maintainers; its address is not public, and `npm run dev` has no Durable Objects, so `/api/transfer` returns 404 there). To see what the in-page QR scanner is doing, open the site with `?scandebug=1` (for example `https://YOUR_SITE/?scandebug=1`) and start a scan. A small overlay shows the decoder in use (native or jsQR), whether `BarcodeDetector` exists and which formats it reports, the camera resolution and focus/torch capabilities, the last error, and the last decoded text; a copy button puts it on the clipboard so you can paste it into a bug report. It is off unless the query parameter is present. A phone where `BarcodeDetector` exists but never reads anything is the case the jsQR fallback is for; report the overlay text if the fallback also fails.

### Workflow

1. Branch from `main` with a short descriptive name (for example `fix/transfer-timeout`).
2. Keep each change focused, with tests where behavior changes.
3. Open a pull request against `main`. CI must pass before merge.
4. Only maintainers deploy the production site with `npm run deploy:production`. Anyone can self-host with the Deploy to Cloudflare button or `npm run deploy:self`; see [`docs/self-host.md`](docs/self-host.md).

### Releases (maintainers)

The version lives in `package.json` (semver). Settings shows it with the build's short commit, e.g. `Version v1.0.0 (abc1234)`; a build with uncommitted changes shows `-dirty`, so build releases from a clean tree.

- **major**: a self-hoster has to act (new or renamed secret/binding, a Durable Object migration) or a stored-data / protocol break.
- **minor**: a new user-visible feature. **patch**: fixes, dependency bumps, copy. Docs-only changes need no release.

1. Add notes under `## [Unreleased]` in `CHANGELOG.md` as changes land.
2. On a clean, up-to-date `main`: `npm run release -- patch` (or `minor` / `major`). It bumps `package.json` and the lockfile, dates the changelog section, commits and creates an annotated `vX.Y.Z` tag, locally only. It never pushes or deploys.
3. Then, with approval: `git push origin main vX.Y.Z`, deploy production, move the `production` tag, and `gh release create vX.Y.Z` with the changelog section as notes.

### Secrets

Never commit secrets: no `.env`, `.dev.vars` (only the placeholder `.dev.vars.example` is tracked), OAuth client secrets, cookie keys, tokens or cookies. Worker secrets are set with `npx wrangler secret put` and never live in the repo. The list of secrets and what each is for is in the README ("For people who self-host") and in [`docs/architecture.md`](docs/architecture.md). OAuth client IDs are public and are fine to commit.

Found a security problem? Do not open an issue; follow [`SECURITY.md`](SECURITY.md).

## 中文

### 准备

使用 Node.js 22（LTS）。按 lockfile 精确安装依赖：

```bash
npm ci
```

### 常用命令

```bash
npm run dev        # 开发服务器 http://localhost:8080（只监听本机；HOST=0.0.0.0 npm run dev 可让局域网访问）
npm test           # 单元测试和集成测试（node --test）
npm run lint       # ESLint，必须 0 个 error
npm run typecheck  # tsc --noEmit
npm run build      # 生产构建，输出到 .output/
```

CI（GitHub Actions）在每次 push 和 pull request 时跑 `npm ci`、类型检查、测试、lint 和构建。开 pull request 前请在本地跑一遍同样的命令。lint 保持 0 error、0 warning。写这段时 `npm test` 共跑 34 个脚本测试加 323 个单元和集成测试。

### 在手机上测试

摄像头和对焦的表现在桌面浏览器里验证不了，所以局域网配对要在真机上对着已部署的 Worker 测（维护者有一个测试站，地址不公开；`npm run dev` 没有 Durable Object，那里 `/api/transfer` 返回 404）。想看页面内扫码器在做什么，用 `?scandebug=1` 打开站点（例如 `https://你的站点/?scandebug=1`）再开始扫码。会出现一个小浮层，显示正在用的解码器（原生或 jsQR）、`BarcodeDetector` 是否存在及其支持的格式、摄像头分辨率和对焦 / 手电筒能力、最近一次错误、最近一次读到的文字；复制按钮可以把内容放进剪贴板，方便贴进问题报告。不带这个参数时浮层不出现。`BarcodeDetector` 存在却始终读不出东西，正是 jsQR 兜底要解决的情况；如果兜底也不行，请把浮层文字发来。

### 流程

1. 从 `main` 拉分支，名字简短说明用途（例如 `fix/transfer-timeout`）。
2. 每个改动保持聚焦；行为有变化就补测试。
3. 向 `main` 开 pull request。CI 通过后才能合并。
4. 只有维护者能用 `npm run deploy:production` 更新正式站。其他人可以用「Deploy to Cloudflare」按钮或 `npm run deploy:self` 自行部署，见 [`docs/self-host.zh-CN.md`](docs/self-host.zh-CN.md)。

### 发布（维护者）

版本号写在 `package.json`（语义化版本）。设置页会连同构建时的短提交号一起显示，例如 `版本 v1.0.0 (abc1234)`；有未提交改动时会带 `-dirty`，所以请在干净的工作区构建正式版本。

- **major**：自建用户需要操作（新增或改名的密钥/绑定、Durable Object 迁移），或存储数据/协议不兼容。
- **minor**：用户能看到的新功能。**patch**：修复、依赖升级、文案。只改文档不需要发布。

1. 改动合入时在 `CHANGELOG.md` 的 `## [Unreleased]` 下写说明。
2. 在干净且最新的 `main` 上运行 `npm run release -- patch`（或 `minor` / `major`）。它会更新 `package.json` 和 lockfile、给更新日志加日期、提交并创建带注释的 `vX.Y.Z` 标签，全部只在本地，不会推送或部署。
3. 之后经确认再：`git push origin main vX.Y.Z`、部署正式站、移动 `production` 标签，并用该版本的更新日志运行 `gh release create vX.Y.Z`。

### 密钥

永远不要提交密钥：不提交 `.env`、`.dev.vars`（只有占位用的 `.dev.vars.example` 进仓库）、OAuth client secret、cookie 密钥、令牌或 cookie。Worker 密钥用 `npx wrangler secret put` 设置，从不放进仓库。需要哪些密钥、各自做什么，见 README“给自己部署的人”和 [`docs/architecture.zh-CN.md`](docs/architecture.zh-CN.md)。OAuth client ID 是公开的，可以提交。

发现安全问题？不要开 issue，请按 [`SECURITY.md`](SECURITY.md) 私下报告。
