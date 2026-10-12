/**
 * The one LAN session for this tab (see src/lib/transfer/lan-session.ts), wired to the browser.
 * Created on first use and kept for the tab's lifetime, so in-app navigation never ends it.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { useDropStore } from "@/lib/drop/store";
import { formatBytes } from "@/lib/drop/format";
import { t } from "@/lib/i18n";
import { createLanSession, type LanSession, type LanState } from "@/lib/transfer/lan-session";
import { createLanLink } from "@/lib/transfer/link";
import { unsavedSummary } from "@/lib/transfer/session-state";

let session: LanSession | null = null;

function wireTab(active: LanSession) {
  window.addEventListener("pagehide", () => active.pageHide());
  window.addEventListener("pageshow", (event) => active.pageShow(event.persisted));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") active.visible();
  });
  // Closing the tab ends the session; ask first while something would be lost.
  window.addEventListener("beforeunload", (event) => {
    const state = active.store.getState();
    const busy = state.phase === "sending" || state.phase === "receiving";
    if (!busy && unsavedSummary(state.saves, state.savedIds).count === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function lanSession(): LanSession {
  if (session) return session;
  session = createLanSession({
    t,
    deviceName: () => useDropStore.getState().settings.deviceName || "device",
    notify: {
      message: (text, options) => void toast.message(text, options),
      warning: (text) => void toast.warning(text),
    },
    fetch: (input, init) => fetch(input, init),
    createLink: createLanLink,
    formatBytes,
    createObjectURL: (source) => URL.createObjectURL(source),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  if (typeof window !== "undefined") wireTab(session);
  return session;
}

export function useLan<T>(selector: (state: LanState) => T): T {
  return useStore(lanSession().store, selector);
}

/** Call `open` whenever a LAN toast's “Open” action asks for the LAN page. */
export function useLanOpenRequests(open: () => void): void {
  const requests = useLan((state) => state.openRequests);
  const openRef = useRef(open);
  openRef.current = open;
  const seen = useRef(requests);
  useEffect(() => {
    if (requests === seen.current) return;
    seen.current = requests;
    openRef.current();
  }, [requests]);
}
