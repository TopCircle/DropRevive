import { X } from "lucide-react";
import { toast } from "sonner";
import { DeleteItem, FolderPicker } from "@/components/drop/desktop-shell";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/drop/format";
import { useDropStore } from "@/lib/drop/store";
import { PROVIDER_LABEL } from "@/lib/drop/types";
import { useI18n } from "@/lib/i18n";

/** Indented lines, code fences or lines ending in braces/semicolons read as code: keep them monospace. */
const CODE_LIKE = /^(\t| {2,})\S|```|[{};]$/m;

/** Item detail: content, meta line, then full-width actions (copy/download, move, delete). */
export function PreviewStage({ onClose, onDeleted }: { onClose?: () => void; onDeleted?: () => void }) {
  const preview = useDropStore((state) => state.preview);
  const download = useDropStore((state) => state.download);
  // The live record, so a move made from this sheet shows up in the meta line right away.
  const live = useDropStore((state) => state.items.find((entry) => entry.id === state.preview?.item.id));
  const { t } = useI18n();
  if (!preview) return null;
  const item = live ?? preview.item;
  const where = [...new Set(item.refs.map((ref) => ref.provider))]
    .map((drive) => [PROVIDER_LABEL[drive], item.folders?.[drive]].filter(Boolean).join(" / "))
    .join(t("preview.join"));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 flex-1 wrap-anywhere text-base font-semibold">{item.kind === "text" ? t("bubble.text") : item.fileName || t("bubble.file")}</h2>
        {onClose && (
          <button
            type="button"
            aria-label={t("preview.close")}
            className="-mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
        )}
      </div>
      {preview.loading && <p className="text-sm text-muted-foreground">{t("preview.loading")}</p>}
      {preview.error && <p className="text-sm text-danger">{preview.error}</p>}
      {preview.mode === "text" &&
        (CODE_LIKE.test(preview.text || "") ? (
          <pre className="scrollbar-pill overflow-x-auto rounded-xl bg-muted p-3 font-mono text-sm leading-6 select-text">{preview.text}</pre>
        ) : (
          <p className="whitespace-pre-wrap break-words text-base leading-7 select-text">{preview.text}</p>
        ))}
      {preview.mode === "image" && preview.url && (
        <img src={preview.url} alt={item.fileName || t("bubble.image")} className="max-h-[60dvh] w-full rounded-xl bg-muted object-contain" />
      )}
      {preview.mode === "pdf" && preview.url && (
        <iframe title={item.fileName || t("preview.pdf")} src={preview.url} className="h-full min-h-80 w-full rounded-xl bg-background" />
      )}
      {preview.mode === "other" && !preview.loading && (
        <p className="text-sm text-muted-foreground">{t("preview.unsupported")}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {[formatWhen(item.createdAt), item.deviceName || t("bubble.unknownDevice"), where].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-1 flex flex-col gap-3">
        {item.kind === "text" ? (
          <Button
            size="lg"
            className="h-12 w-full rounded-full"
            disabled={!preview.text}
            onClick={() =>
              void navigator.clipboard.writeText(preview.text || "").then(
                () => toast.success(t("bubble.copied")),
                () => toast.error(t("bubble.copyFailed")),
              )
            }
          >
            {t("preview.copy")}
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-12 w-full rounded-full"
            onClick={() =>
              void download(item).catch((error: unknown) => {
                toast.error(error instanceof Error ? error.message : t("bubble.downloadFailed"));
              })
            }
          >
            {t("preview.download")}
          </Button>
        )}
        <FolderPicker itemId={item.id} className="h-12 w-full max-w-none rounded-full px-4 text-sm text-foreground" />
        {onDeleted && (
          <DeleteItem itemId={item.id} className="h-12 w-full rounded-full bg-danger/10 text-sm font-medium text-danger hover:bg-danger/15 hover:text-danger" onDeleted={onDeleted}>
            {t("preview.delete")}
          </DeleteItem>
        )}
      </div>
    </section>
  );
}
