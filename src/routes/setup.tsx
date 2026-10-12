import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SELF_HOST_DOC_URL, SELF_HOST_DOC_ZH_URL } from "@/lib/links";
import type { ConfigKey } from "@/lib/runtime-config";
import { getSetupStatus } from "@/lib/server-config";
import {
  AZURE_PERMISSIONS,
  GOOGLE_SCOPE_TEXT,
  type ItemState,
  type SetupDetails,
  type SetupStatus,
} from "@/lib/setup-status";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "部署自检 · Setup check · DropRevive" },
      { name: "robots", content: "noindex" },
    ],
  }),
  loader: () => getSetupStatus(),
  // Always re-check: the operator is changing secrets in another tab.
  staleTime: 0,
  component: Setup,
});

const LABELS: Record<ConfigKey, { zh: string; en: string; anchor: string }> = {
  GOOGLE_CLIENT_ID: { zh: "Google 客户端 ID", en: "Google client ID", anchor: "google" },
  GOOGLE_CLIENT_SECRET: { zh: "Google 客户端密钥", en: "Google client secret", anchor: "google" },
  MS_CLIENT_ID: { zh: "Azure 应用（客户端）ID", en: "Azure application (client) ID", anchor: "onedrive" },
  MS_CLIENT_SECRET: { zh: "Azure 客户端密钥", en: "Azure client secret", anchor: "onedrive" },
  DRIVE_COOKIE_KEY: { zh: "Cookie 加密密钥（32 字节）", en: "Cookie key (32 bytes)", anchor: "cookie-key" },
  ALLOWED_ORIGINS: { zh: "允许的站点地址", en: "Allowed origins", anchor: "allowed-origins" },
};

const STATE_TEXT: Record<ItemState, { zh: string; en: string; tone: string; mark: string }> = {
  ok: { zh: "已配置", en: "set", tone: "text-ok", mark: "✓" },
  fallback: { zh: "用构建时的值", en: "build value", tone: "text-ok", mark: "✓" },
  off: { zh: "未设置（可选）", en: "not set (optional)", tone: "text-muted-foreground", mark: "–" },
  "same-origin": { zh: "未设置：仅同源", en: "not set: same-origin only", tone: "text-ok", mark: "✓" },
  invalid: { zh: "不对", en: "invalid", tone: "text-warn", mark: "!" },
};

function Setup() {
  const status = Route.useLoaderData() as SetupStatus;
  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-5 py-10 text-sm leading-7">
      <a href="/" className="text-muted-foreground underline underline-offset-4">
        ← 回到 DropRevive
      </a>
      <h1 className="mt-6 text-2xl font-semibold">部署自检</h1>
      <p className="text-muted-foreground">Setup check · 只显示是否配置，不显示任何密钥 / never shows secret values</p>
      <Verdict status={status} />
      {status.mode === "details" ? <Details status={status} /> : <SummaryNote />}
      <DocLinks />
    </main>
  );
}

function Verdict({ status }: { status: SetupStatus }) {
  const drives = [status.drives.google && "Google Drive", status.drives.microsoft && "OneDrive"].filter(Boolean);
  return (
    <section
      data-testid="setup-verdict"
      data-ready={status.ready ? "yes" : "no"}
      className="mt-5 rounded-lg border border-border bg-card px-4 py-3"
    >
      <p className="font-medium text-ok">✓ 网站已部署，局域网直传可以用 · Deployed; LAN transfer works</p>
      {status.ready ? (
        <p className="font-medium text-ok">✓ 网盘已开通：{drives.join("、")} · Drives on: {drives.join(", ")}</p>
      ) : (
        <p className="text-muted-foreground">
          网盘还没开通（可选，随时可以在下面配置）· No drive configured yet (optional; set it up any time below)
        </p>
      )}
      {status.mode === "summary" && status.attention > 0 ? (
        <p className="text-muted-foreground">有 {status.attention} 项需要处理 · {status.attention} item(s) need attention</p>
      ) : null}
    </section>
  );
}

function SummaryNote() {
  return (
    <p className="mt-4 text-muted-foreground">
      这是 DropRevive 官方站，只显示摘要。自己部署时，打开你自己站点的 /setup 查看详细检查。
      <br />
      This is the official site, so only a summary is shown. On your own deployment, /setup shows the full check.
    </p>
  );
}

function Details({ status }: { status: SetupDetails }) {
  return (
    <>
      <h2 className="mt-8 font-medium">Worker 密钥（全部可选）· Worker secrets (all optional)</h2>
      <p className="text-xs text-subtle">
        先部署，再配置：Cloudflare 后台 → Workers → 你的 Worker → Settings → Variables and Secrets，类型选 Secret，保存后刷新本页即可，不用重新部署。
        一个网盘要同时有客户端 ID、客户端密钥和 <code className="font-mono">DRIVE_COOKIE_KEY</code> 才会开通；不用的网盘不填或填{" "}
        <code className="font-mono">none</code>。
        <br />
        Deploy first, configure later: add these as type Secret under Settings → Variables and Secrets, then reload this page (no redeploy). A drive is on
        only with its client ID, its client secret and <code className="font-mono">DRIVE_COOKIE_KEY</code>; leave an unused drive empty or{" "}
        <code className="font-mono">none</code>.
      </p>
      <DriveLines status={status} />
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
        {status.items.map((item) => {
          const label = LABELS[item.key];
          const state = STATE_TEXT[item.state];
          return (
            <li key={item.key} data-key={item.key} data-state={item.state} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
              <span className={`w-4 shrink-0 font-semibold ${state.tone}`} aria-hidden>
                {state.mark}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono text-xs">{item.key}</code>
                  <span className="text-muted-foreground">
                    {label.zh} · {label.en}
                  </span>
                </div>
                {item.value ? <div className="break-all font-mono text-xs text-subtle">{item.value}</div> : null}
                <Hint item={item.key} state={item.state} status={status} />
              </div>
              <span className={`shrink-0 text-xs ${state.tone}`}>
                {state.zh} · {state.en}
              </span>
            </li>
          );
        })}
      </ul>

      <h2 className="mt-8 font-medium">回调地址 · Redirect URIs</h2>
      <p className="text-xs text-subtle">
        原样复制到 Google 和 Azure 的应用设置里。换了域名要重新加。Copy these exactly; add them again after changing the domain.
      </p>
      <CopyRow label="Google · Authorized redirect URI" value={status.callbacks.google} />
      <CopyRow label="Azure · Web → Redirect URI" value={status.callbacks.microsoft} />

      <h2 className="mt-8 font-medium">权限 · Permissions</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Google：只要 <code className="font-mono text-xs">{GOOGLE_SCOPE_TEXT}</code>。同意屏幕要点「发布应用」改成「正式版」，留在「测试」模式时登录约 7 天就失效。
          <br />
          <span className="text-muted-foreground">Google: scope drive.file only. Publish the consent screen to “In production”; in Testing, sign-in expires after about 7 days.</span>
        </li>
        <li>
          Azure（Microsoft Graph，委托权限 delegated）：
          {AZURE_PERMISSIONS.map((permission) => (
            <code key={permission} className="mx-1 font-mono text-xs">
              {permission}
            </code>
          ))}
          。账户类型选「任何组织目录中的帐户和个人 Microsoft 帐户」。客户端密钥最长 24 个月，到期前要换。
          <br />
          <span className="text-muted-foreground">
            Supported account types: any organizational directory and personal Microsoft accounts. Client secrets expire (max 24 months); rotate them in time.
          </span>
        </li>
      </ul>
    </>
  );
}

function DriveLines({ status }: { status: SetupDetails }) {
  const line = (on: boolean, name: string) => (
    <li className={on ? "text-ok" : "text-muted-foreground"}>
      {on ? "✓" : "–"} {name}：{on ? "已开通 · on" : "未开通 · not configured"}
    </li>
  );
  return (
    <ul className="mt-2 space-y-0.5 text-xs" data-testid="setup-drives">
      {line(status.drives.google, "Google Drive")}
      {line(status.drives.microsoft, "OneDrive")}
      <li className="text-ok">✓ 局域网直传 · LAN transfer：不需要任何密钥 · needs no secrets</li>
    </ul>
  );
}

function Hint({ item, state, status }: { item: ConfigKey; state: ItemState; status: SetupDetails }) {
  if (item === "ALLOWED_ORIGINS") {
    if (state === "same-origin") {
      return (
        <p className="text-xs text-subtle">
          未设置：只允许本站自己的地址（当前：<code className="font-mono">{status.origin}</code>）。只有要让别的地址用本站登录 / 配对时才需要设置。
          <br />
          Not set: same-origin only (current: <code className="font-mono">{status.origin}</code>). Set it only to allow other origins.
        </p>
      );
    }
    if (state === "ok") return <p className="text-xs text-subtle">当前地址已在列表里 · This origin is listed ({status.allowedCount})</p>;
    if (status.originMode === "malformed") {
      return (
        <p className="text-xs text-warn">
          {status.invalidOrigins} 条都格式不对，所以什么地址都不允许（网盘登录和局域网直传都会被拒）。改成{" "}
          <code className="font-mono">{status.origin}</code> 这样的完整地址，或删掉这一项（删掉后只允许本站地址）。
          <br />
          Every entry is malformed, so nothing is allowed (fail closed: drive sign-in and LAN transfer are refused). Use full origins such as{" "}
          <code className="font-mono">{status.origin}</code>, or delete the variable for same-origin only.
        </p>
      );
    }
    return (
      <p className="text-xs text-warn">
        列表里没有当前地址，网盘登录和局域网直传会被拒。把 <code className="font-mono">{status.origin}</code> 加进去（逗号分隔），或删掉这一项（只允许本站地址）· This
        origin is not listed: add it (comma-separated), or delete the variable for same-origin only
        {status.invalidOrigins > 0 ? ` · ${status.invalidOrigins} 条格式不对 / malformed` : ""}
      </p>
    );
  }
  if (item === "DRIVE_COOKIE_KEY" && state === "invalid") {
    return (
      <p className="text-xs text-warn">
        解码后不是 32 字节，两个网盘都不会开通 · Does not decode to 32 bytes, so both drives stay off. 生成 / generate:{" "}
        <code className="font-mono">openssl rand -base64 32</code>
      </p>
    );
  }
  if (item === "DRIVE_COOKIE_KEY" && state === "off") {
    return (
      <p className="text-xs text-subtle">
        两个网盘都要用它（加密登录 cookie）· Both drives need it (seals the sign-in cookie). 生成 / generate:{" "}
        <code className="font-mono">openssl rand -base64 32</code>
      </p>
    );
  }
  if (state === "fallback") {
    return <p className="text-xs text-subtle">Worker 里没设，用的是构建时写入的值 · Not set on the Worker; using the build-time value</p>;
  }
  return null;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-border bg-card px-4 py-2.5">
      <div className="text-xs text-subtle">{label}</div>
      <div className="flex items-center gap-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "已复制 Copied" : "复制 Copy"}
        </button>
      </div>
    </div>
  );
}

function DocLinks() {
  return (
    <p className="mt-8 text-muted-foreground">
      详细步骤见{" "}
      <a className="underline underline-offset-4" href={SELF_HOST_DOC_ZH_URL} target="_blank" rel="noopener noreferrer">
        自部署指南
      </a>{" "}
      · Step-by-step:{" "}
      <a className="underline underline-offset-4" href={SELF_HOST_DOC_URL} target="_blank" rel="noopener noreferrer">
        docs/self-host.md
      </a>
    </p>
  );
}
