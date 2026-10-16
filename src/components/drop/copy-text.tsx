import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { extractCode } from "@/lib/drop/otp";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Visible Copy on a received text; a code in it gets its own highlighted button. */
export function CopyText({ text, className }: { text: string; className?: string }) {
  const code = extractCode(text);
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {code && <CopyButton value={code} label="copy.code" strong />}
      {code !== text.trim() && <CopyButton value={text} label="copy.text" />}
    </span>
  );
}

function CopyButton({ value, label, strong = false }: { value: string; label: "copy.code" | "copy.text"; strong?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium",
        strong ? "bg-accent text-accent-foreground hover:opacity-90" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error(t("bubble.copyFailed")),
        );
      }}
    >
      <Icon className="size-3.5" />
      {copied ? t("bubble.copied") : t(label, { code: value })}
    </button>
  );
}
