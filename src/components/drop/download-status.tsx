import { describeDownload } from "@/lib/drop/download";
import { useDropStore } from "@/lib/drop/store";

/** Shared by the desktop bubble and the preview button. Toast is not this status. */
export function DownloadStatus({ itemId }: { itemId: string }) {
  const view = useDropStore((state) => (state.downloadView?.itemId === itemId ? state.downloadView : null));
  if (!view) return null;
  const label = describeDownload(view);
  const ratio =
    view.phase === "progress" && view.total && view.total > 0 ? Math.min(1, view.loaded / view.total) : null;
  return (
    <div className="mt-1 w-full max-w-full" role="status" aria-live="polite">
      <p className={view.phase === "error" ? "text-xs text-danger" : "text-xs text-muted-foreground"}>{label}</p>
      {ratio !== null && (
        <div
          className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={view.total ?? 0}
          aria-valuenow={Math.min(view.loaded, view.total ?? view.loaded)}
          aria-valuetext={label}
        >
          <div className="h-full bg-foreground" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
