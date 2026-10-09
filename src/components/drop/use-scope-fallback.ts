import { useEffect } from "react";
import { scopeAfterShelves } from "@/lib/drop/reconcile";
import { useDropStore } from "@/lib/drop/store";
import type { Scope } from "@/lib/drop/types";

/** Leaves a selected folder once it's no longer listed (e.g. its drive was disconnected). */
export function useScopeFallback(scope: Scope, setScope: (scope: Scope) => void): void {
  const shelves = useDropStore((state) => state.shelves);
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  const hydrated = useDropStore((state) => state.hydrated);
  useEffect(() => {
    if (!hydrated || scope.provider === "all") return;
    const next = scopeAfterShelves(scope, shelves, Boolean(scope.provider === "google" ? google : microsoft));
    if (next !== scope) setScope(next);
  }, [hydrated, scope, shelves, google, microsoft, setScope]);
}
