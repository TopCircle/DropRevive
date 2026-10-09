import { t } from "@/lib/i18n";
import { PROVIDER_LABEL, type Scope, type Shelf } from "@/lib/drop/types";

/** Scope helpers shared by the desktop shell, the phone app and the history pane. */

export const ALL_SCOPE: Scope = { provider: "all", shelfId: null };

export function scopeLabel(scope: Scope, shelves: Shelf[]): string {
  if (scope.provider === "all") return t("nav.all");
  const folder = scope.shelfId && (shelves.find((shelf) => shelf.id === scope.shelfId)?.name || scope.shelfId);
  return folder ? `${PROVIDER_LABEL[scope.provider]} / ${folder}` : PROVIDER_LABEL[scope.provider];
}
