import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { DEBUG, debugLines, runNetworkTest, subscribeDebug } from "@/lib/transfer/diagnostics";

const NONE: string[] = [];
const never = () => () => {};

/** ?debug=1 only: the P2P log, a one-tap copy and a single-device network test. The server renders nothing. */
export function P2pDebug() {
  const on = useSyncExternalStore(never, () => DEBUG, () => false);
  return on ? <DebugPanel /> : null;
}

function DebugPanel() {
  const { t } = useI18n();
  const lines = useSyncExternalStore(subscribeDebug, debugLines, () => NONE);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const role = [...lines].reverse().find((line) => / as (creator|joiner) /.test(line))?.match(/ as (creator|joiner) /)?.[1] ?? "-";
  const text = [
    `DropRevive ${__APP_VERSION__} (${__APP_REVISION__})`,
    `ua: ${navigator.userAgent}`,
    `now: ${new Date().toString()}`,
    `role: ${role}`,
    ...lines,
  ].join("\n");
  return (
    <div className="mb-3 rounded-xl border border-border bg-muted p-2 text-[11px] leading-snug">
      <div className="mb-2 flex gap-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-card px-2 py-1 font-medium disabled:opacity-50"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            void runNetworkTest().finally(() => setTesting(false));
          }}
        >
          {testing ? t("debug.testing") : t("debug.test")}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border bg-card px-2 py-1 font-medium"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => toast.error(t("bubble.copyFailed")),
            )
          }
        >
          {copied ? t("bubble.copied") : t("debug.copy")}
        </button>
      </div>
      <pre className="scrollbar-pill max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono">{text}</pre>
    </div>
  );
}
