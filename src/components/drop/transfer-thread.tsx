import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatWhen } from "@/lib/drop/format";
import { useI18n } from "@/lib/i18n";
import type { BatchStatus, NoticeTone, TimelineBatch, TimelineEntry } from "@/lib/transfer/timeline";

export type ThreadFile = { id: string; name: string; mime: string; bytes: Uint8Array };

export function TransferThread({
  entries,
  saves,
  savedIds,
  previews,
  onAccept,
  onReject,
  onSave,
}: {
  entries: TimelineEntry[];
  saves: ThreadFile[];
  savedIds: ReadonlySet<string>;
  previews: Readonly<Record<string, string>>;
  onAccept: () => void;
  onReject: () => void;
  onSave: (file: ThreadFile) => void;
}) {
  const { t } = useI18n();
  const saveById = new Map(saves.map((file) => [file.id, file]));
  if (entries.length === 0) {
    return <p className="px-1 py-6 text-sm leading-6 text-muted-foreground">{t("transfer.threadEmpty")}</p>;
  }
  return (
    <ol className="flex w-full min-w-0 flex-col gap-2 py-2">
      {entries.map((entry) =>
        entry.kind === "notice" ? (
          <li key={entry.id} className={`px-2 py-1 text-center text-xs leading-5 ${noticeClass(entry.tone)}`}>
            {entry.text}
          </li>
        ) : (
          <li key={entry.id} className="flex w-full min-w-0 flex-col items-start">
            <BatchCard
              entry={entry}
              saveById={saveById}
              savedIds={savedIds}
              previews={previews}
              onAccept={onAccept}
              onReject={onReject}
              onSave={onSave}
            />
          </li>
        ),
      )}
    </ol>
  );
}

function noticeClass(tone: NoticeTone): string {
  if (tone === "fail") return "text-danger";
  if (tone === "reconnect") return "text-foreground";
  return "text-muted-foreground";
}

function BatchCard({
  entry,
  saveById,
  savedIds,
  previews,
  onAccept,
  onReject,
  onSave,
}: {
  entry: TimelineBatch;
  saveById: Map<string, ThreadFile>;
  savedIds: ReadonlySet<string>;
  previews: Readonly<Record<string, string>>;
  onAccept: () => void;
  onReject: () => void;
  onSave: (file: ThreadFile) => void;
}) {
  const { t } = useI18n();
  const when = formatWhen(new Date(entry.at).toISOString());
  const who = t(entry.direction === "out" ? "transfer.outFrom" : "transfer.inFrom", { name: entry.sender });
  const ratio = entry.total > 0 ? Math.min(100, Math.round((entry.done / entry.total) * 100)) : 0;
  return (
    <article className="w-full max-w-full min-w-0 rounded-2xl border border-border bg-card px-3 py-2">
      <p className="text-xs text-subtle">
        {when} · {who}
      </p>
      <p className={`mt-1 text-xs font-medium ${entry.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>
        {batchLabel(entry.status, t)}
      </p>
      {entry.text ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.text}</p>
      ) : (
        entry.direction === "in" &&
        entry.textBytes > 0 && <p className="mt-2 text-sm text-muted-foreground">{t("transfer.textPending", { size: formatBytes(entry.textBytes) })}</p>
      )}
      {entry.files.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {entry.files.map((file) => {
            const saved = saveById.get(file.id);
            return (
              <li key={file.id} className="flex min-w-0 flex-col gap-2 text-sm">
                {previews[file.id] && <SessionThumb url={previews[file.id]} name={file.name} />}
                <span className="flex min-w-0 flex-col items-start gap-2">
                  <span className="max-w-full wrap-anywhere">
                    {file.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                  </span>
                {entry.direction === "in" && entry.status === "done" && saved && (
                  <Button variant="secondary" className="h-auto max-w-full min-h-11 whitespace-normal wrap-anywhere py-2 text-left" onClick={() => onSave(saved)}>
                    {savedIds.has(file.id) ? t("transfer.saved", { name: file.name }) : t("transfer.saveOne", { name: file.name })}
                  </Button>
                )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {entry.status === "transfer" && entry.total > 0 && (
        <div className="mt-2">
          <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full bg-foreground" style={{ width: `${ratio}%` }} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("transfer.progress", { done: formatBytes(entry.done), total: formatBytes(entry.total) })}
          </p>
        </div>
      )}
      {entry.direction === "in" && entry.status === "confirm" && (
        <div className="mt-3 flex gap-2">
          <Button onClick={onAccept}>{t("transfer.confirm")}</Button>
          <Button variant="secondary" onClick={onReject}>
            {t("transfer.reject")}
          </Button>
        </div>
      )}
    </article>
  );
}

function SessionThumb({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="w-60 max-w-full overflow-hidden rounded-xl bg-muted">
      <img src={url} alt={name} className="block max-h-60 w-full object-cover" onError={() => setFailed(true)} />
    </div>
  );
}

function batchLabel(status: BatchStatus, t: (key: "transfer.batchWaiting" | "transfer.batchConfirm" | "transfer.batchTransfer" | "transfer.batchDone" | "transfer.batchDeclined" | "transfer.batchFailed") => string): string {
  if (status === "waiting") return t("transfer.batchWaiting");
  if (status === "confirm") return t("transfer.batchConfirm");
  if (status === "transfer") return t("transfer.batchTransfer");
  if (status === "done") return t("transfer.batchDone");
  if (status === "declined") return t("transfer.batchDeclined");
  return t("transfer.batchFailed");
}
