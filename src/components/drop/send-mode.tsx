import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Composer } from "@/components/drop/composer";
import { TransferPanel } from "@/components/drop/transfer-panel";
import { useDropStore } from "@/lib/drop/store";
import { useI18n } from "@/lib/i18n";
import type { Scope } from "@/lib/drop/types";

export function SendMode({
  compact = false,
  seed,
  scope,
  mode,
  frameClassName,
  onLeaveToInbox,
  onHold,
}: {
  compact?: boolean;
  seed?: { key: number; text: string; files: File[] } | null;
  scope: Scope;
  mode: "inbox" | "lan";
  /** Desktop message column. The timeline scroller stays full-pane so its scrollbar matches the inbox. */
  frameClassName?: string;
  onLeaveToInbox?: () => void;
  onHold?: (held: boolean) => void;
}) {
  const { t } = useI18n();
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  const openSettings = useDropStore((state) => state.openSettings);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const driveConnected = Boolean(google || microsoft);

  async function saveToCloud() {
    if (!useDropStore.getState().google && !useDropStore.getState().microsoft) {
      openSettings();
      return;
    }
    if (useDropStore.getState().busy) return;
    const result = await useDropStore.getState().send(text.trim() ? [text] : [], files, { provider: "all", shelfId: null });
    if (result.sent > 0) {
      const failedIndexes = new Set(result.failedFileIndexes ?? []);
      if (result.textSent !== false) setText("");
      setFiles(files.filter((_, index) => failedIndexes.has(index)));
      if (result.failed === 0) toast.success(result.message);
      else toast.warning(result.message);
      return;
    }
    toast.error(result.message);
  }
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    setFiles(seed.files);
  }, [seed]);
  const composer = (
    <Composer compact={compact} scope={scope} text={text} files={files} onText={setText} onFiles={setFiles} hideSend={mode === "lan"} />
  );
  if (mode !== "lan") return composer;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TransferPanel
        compact={compact}
        frameClassName={frameClassName}
        text={text}
        files={files}
        onUseCloud={onLeaveToInbox}
        onHold={onHold}
        onAlsoCloud={driveConnected ? () => void saveToCloud() : undefined}
        onClearDraft={() => {
          setText("");
          setFiles([]);
        }}
        alsoCloudLabel={driveConnected ? t("transfer.alsoCloud") : undefined}
        composer={composer}
      />
    </div>
  );
}
