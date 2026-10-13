import { Plus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/drop/format";
import { sendTargets, useDropStore } from "@/lib/drop/store";
import { t, useI18n } from "@/lib/i18n";
import { PROVIDER_LABEL, type Scope } from "@/lib/drop/types";

/** True when this composer is the one on screen. A parked inbox composer stays mounted under `hidden`. */
function onScreen(node: HTMLElement | null): boolean {
  return node !== null && node.isConnected && node.getClientRects().length > 0;
}

function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const images: File[] = [];
  const stamp = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const mark = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const take = (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const subtype = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").split("+")[0] || "png";
    images.push(
      new File([file], t("composer.pasteName", { mark, n: images.length + 1, ext: subtype }), {
        type: file.type,
        lastModified: Date.now(),
      }),
    );
  };
  if (data.items?.length) {
    for (const item of data.items) {
      if (item.kind === "file") take(item.getAsFile());
    }
  }
  if (!images.length) {
    for (const file of data.files) take(file);
  }
  return images;
}

export function Composer({
  compact = false,
  scope,
  text,
  files,
  onText,
  onFiles,
  hideSend = false,
  directSend,
}: {
  /** Mobile: one-line textarea, smaller send button, same behavior. */
  compact?: boolean;
  /** Sidebar selection = where a cloud send goes. */
  scope: Scope;
  text: string;
  files: File[];
  onText: (text: string) => void;
  onFiles: (files: File[]) => void;
  /** Direct mode keeps the fields and does not offer a cloud send. */
  hideSend?: boolean;
  /** LAN session send. Leaves the draft in place and does not touch cloud history. */
  directSend?: { label: string; disabled?: boolean; hint?: string; onSend: () => void };
}) {
  const send = useDropStore((state) => state.send);
  const jobs = useDropStore((state) => state.jobs);
  const busy = useDropStore((state) => state.busy);
  const openSettings = useDropStore((state) => state.openSettings);
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  const { t } = useI18n();
  const { targets, note } = sendTargets(scope.provider, google, microsoft);
  const connected = targets.length > 0;
  const where =
    scope.provider === "all"
      ? targets.map((id) => PROVIDER_LABEL[id]).join(t("composer.and")) || t("composer.noDrive")
      : `${PROVIDER_LABEL[scope.provider]}${scope.shelfId ? ` / ${scope.shelfId}` : ""}${connected ? "" : t("composer.scopeOff")}`;
  const [dragging, setDragging] = useState(false);
  const [again, setAgain] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const sendRef = useRef<() => void>(() => undefined);

  function addFiles(list: FileList | File[]) {
    const next = [...files];
    for (const file of list) {
      if (next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) {
        continue;
      }
      next.push(file);
    }
    onFiles(next);
    setAgain(false);
  }

  function sendDirect() {
    if (!directSend || directSend.disabled) return;
    directSend.onSend();
  }

  async function onSend() {
    if (directSend) {
      sendDirect();
      return;
    }
    if (hideSend || busy) return;
    if (!connected) {
      toast.error(note || t("composer.needDrive"));
      openSettings();
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) {
      toast.message(t("composer.needContent"));
      areaRef.current?.focus();
      return;
    }
    const result = await send(trimmed ? [trimmed] : [], files, scope);
    if (result.sent > 0) {
      const failedIndexes = new Set(result.failedFileIndexes ?? []);
      const remaining = files.filter((_, index) => failedIndexes.has(index));
      if (result.textSent !== false) onText("");
      onFiles(remaining);
      setAgain(remaining.length === 0 && result.textSent !== false);
      if (result.failed === 0) toast.success(result.message);
      else toast.warning(result.message);
      return;
    }
    toast.error(result.message);
  }

  sendRef.current = () => {
    if (directSend) {
      sendDirect();
      return;
    }
    if (hideSend) return;
    void onSend();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      if (!onScreen(formRef.current)) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-settings-dialog]")) return;
      event.preventDefault();
      sendRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const label = busy ? t("composer.sending") : connected ? t("composer.send") : t("composer.sendNeedDrive");

  return (
    <form
      ref={formRef}
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (directSend) {
          sendDirect();
          return;
        }
        if (!hideSend) void onSend();
      }}
      onPaste={(event) => {
        const images = clipboardImages(event.clipboardData);
        if (!images.length) return;
        event.preventDefault();
        addFiles(images);
      }}
    >
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
        }}
        className={`flex min-w-0 flex-col rounded-3xl border bg-card ${compact ? "" : "min-h-28"} ${dragging ? "border-dashed border-foreground bg-muted" : "border-border"}`}
      >
        <label className="flex min-h-0 flex-1 flex-col">
          <span className="sr-only">{t("composer.contentLabel")}</span>
          <textarea
            ref={areaRef}
            value={text}
            rows={compact ? 1 : 2}
            onChange={(event) => {
              onText(event.target.value);
              setAgain(false);
            }}
            placeholder={t("composer.placeholder")}
            className="scrollbar-pill min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 text-base text-foreground outline-none placeholder:text-subtle"
          />
        </label>
        {files.length > 0 && (
          <ul className={`flex min-w-0 flex-col gap-2 px-3 pb-3 ${compact ? "scrollbar-pill max-h-32 overflow-x-hidden overflow-y-auto" : ""}`}>
            {files.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`} className="flex min-w-0 items-start gap-3 rounded-xl bg-muted px-3 py-2">
                {file.type.startsWith("image/") && <PastedThumb file={file} />}
                <div className="min-w-0 flex-1">
                  <p className="wrap-anywhere text-sm">{file.name || t("composer.unnamed")}</p>
                  <p className="font-mono text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                </div>
                <button
                  type="button"
                  className="text-sm text-muted-foreground"
                  onClick={() => onFiles(files.filter((_, itemIndex) => itemIndex !== index))}
                >
                  {t("composer.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label={t("composer.attach")}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-muted"
              onClick={() => inputRef.current?.click()}
            >
              <Plus className="size-4" />
            </button>
            {!hideSend && !directSend && <span className="truncate text-xs text-subtle">{t("composer.to", { where })}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!hideSend && !directSend && again && (
              <button
                type="button"
                className="text-sm text-muted-foreground underline"
                onClick={() => {
                  setAgain(false);
                  areaRef.current?.focus();
                }}
              >
                {t("composer.again")}
              </button>
            )}
            {directSend?.hint && <span className="truncate text-xs text-muted-foreground">{directSend.hint}</span>}
            {directSend ? (
              <Button type="submit" size={compact ? "md" : "lg"} className="w-auto" disabled={directSend.disabled}>
                <Send className="size-4" />
                {directSend.label}
              </Button>
            ) : (
              !hideSend && (
                <Button type="submit" size={compact ? "sm" : "lg"} className="w-auto disabled:opacity-60" disabled={busy}>
                  <Send className="size-4" />
                  {label}
                </Button>
              )
            )}
          </div>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {jobs.length > 0 && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted" aria-live="polite">
          <div
            className="h-full bg-foreground"
            style={{ width: `${Math.round((jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length) * 100)}%` }}
          />
        </div>
      )}
    </form>
  );
}

function PastedThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  return <img src={url} alt="" className="size-10 shrink-0 rounded-lg object-cover" />;
}
