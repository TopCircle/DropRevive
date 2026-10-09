import { createFileRoute } from "@tanstack/react-router";
import { TelegramIcon } from "@/components/drop/telegram-icon";
import { TELEGRAM_URL } from "@/lib/links";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "隐私说明 · DropRevive" },
      { name: "description", content: "DropRevive 的隐私说明：文件只在你自己的 Google Drive 或 OneDrive 里，服务器不存任何内容。" },
    ],
  }),
  component: Privacy,
});

const CONTACT_URL = TELEGRAM_URL;
const CONTACT_HANDLE = "@droprevive";

function Privacy() {
  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-5 py-10 text-sm leading-7">
      <a href="/" className="text-muted-foreground underline underline-offset-4">
        ← 回到 DropRevive
      </a>

      <h1 className="mt-6 text-2xl font-semibold">隐私说明</h1>
      <p className="mt-1 text-xs text-subtle">更新于 2026-10-05</p>

      <ul className="mt-5 list-disc space-y-2 pl-5">
        <li>DropRevive 不在自己的服务器上保存你的任何文件、文字或账号资料。</li>
        <li>你投送的文件和文字只存在你自己的 Google Drive 或 OneDrive 里的「DropRevive」文件夹中。</li>
        <li>
          Google 只授权 <code className="font-mono text-xs">drive.file</code>：DropRevive 只能看到它自己创建的文件，碰不到你网盘里的其他文件。
        </li>
        <li>
          为了免去反复登录，网盘的刷新令牌经过加密，存放在你这台设备上的 HttpOnly Cookie 里。服务器只在续签时临时解密使用，不留副本，也不记录令牌。
        </li>
        <li>没有统计分析、没有广告，也不与任何第三方分享数据。</li>
        <li>
          局域网直传时，服务器只短暂保存配对用的房间代码、随机令牌和设备名（未配对约 10 分钟过期，会话最长约 2 小时，到期删除），以及按 IP 的一分钟限流计数；文件和文字经设备间直连传输，不经过服务器。
        </li>
      </ul>

      <h2 className="mt-6 font-medium">怎样撤销授权</h2>
      <ul className="mt-2 list-disc space-y-2 pl-5">
        <li>在 DropRevive 的「设置」里点「断开」，会清除这台设备上的登录。</li>
        <li>
          想让所有设备都失去访问权：Google 到{" "}
          <a className="underline underline-offset-4" href="https://myaccount.google.com/permissions">
            myaccount.google.com/permissions
          </a>
          ，Microsoft 到{" "}
          <a className="underline underline-offset-4" href="https://account.live.com/consent/Manage">
            account.live.com/consent/Manage
          </a>
          。
        </li>
      </ul>

      <h2 className="mt-6 font-medium">联系</h2>
      <p className="mt-2">
        <TelegramIcon className="mr-1 inline size-4 align-text-bottom" />
        Telegram 群组{" "}
        <a className="underline underline-offset-4" href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
          {CONTACT_HANDLE}
        </a>
      </p>

      <hr className="my-8 border-border" />

      <section lang="en" className="text-muted-foreground">
        <h2 className="font-medium text-foreground">Privacy (English)</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>DropRevive keeps no files, text or account data on its own servers.</li>
          <li>What you send lives only in the DropRevive folder of your own Google Drive or OneDrive.</li>
          <li>
            The Google scope is <code className="font-mono text-xs">drive.file</code>: the app can only access files it created.
          </li>
          <li>
            Refresh tokens are stored encrypted in an HttpOnly cookie on your device. The server decrypts them only to renew access and keeps no copy and no logs of them.
          </li>
          <li>No analytics, no ads, no sharing with third parties.</li>
          <li>
            Revoke: “Disconnect” in Settings (this device), or{" "}
            <a className="underline underline-offset-4" href="https://myaccount.google.com/permissions">
              myaccount.google.com/permissions
            </a>{" "}
            /{" "}
            <a className="underline underline-offset-4" href="https://account.live.com/consent/Manage">
              account.live.com/consent/Manage
            </a>{" "}
            (all devices).
          </li>
          <li>
            Contact: <TelegramIcon className="mr-1 inline size-4 align-text-bottom" />
            Telegram group{" "}
            <a className="underline underline-offset-4" href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
              {CONTACT_HANDLE}
            </a>
          </li>
        </ul>
      </section>
    </main>
  );
}
