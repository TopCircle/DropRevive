import { useLan } from "@/components/drop/lan-session-store";
import { useI18n } from "@/lib/i18n";
import { lanBadge, pendingOffers, unsavedSummary } from "@/lib/transfer/session-state";

/** On the LAN nav item: a dot while linked, and how many offers / unsaved files wait for the user. */
export function LanBadge({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  const phase = useLan((state) => state.phase);
  const unsaved = useLan((state) => unsavedSummary(state.saves, state.savedIds).count);
  const offers = useLan((state) => pendingOffers(state.entries));
  const badge = lanBadge({ phase, unsaved, pendingOffers: offers });
  if (!badge.live && badge.count === 0) return null;
  const label = badge.count > 0 ? t("nav.lanBadge", { count: badge.count }) : t("nav.lanLive");
  if (badge.count > 0) {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={`${collapsed ? "absolute -right-1 -top-1" : "ml-auto"} inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-semibold leading-none text-background`}
      >
        {badge.count}
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`${collapsed ? "absolute right-0.5 top-0.5" : "ml-auto"} size-2 rounded-full bg-emerald-500`}
    />
  );
}
