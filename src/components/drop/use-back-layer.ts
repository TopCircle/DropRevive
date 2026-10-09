import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { openLayer } from "@/components/drop/back-layer";

/**
 * While `open`, the phone / browser Back gesture and Esc close this layer (see back-layer.ts).
 * Uses the router's history so TanStack Router's own index bookkeeping stays consistent.
 */
export function useBackLayer(open: boolean, onClose: () => void) {
  const router = useRouter();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const layer = openLayer(router.history, () => close.current());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !layer.isTop() || event.defaultPrevented) return;
      // A confirm dialog on top handles its own Esc.
      if (document.querySelector('[role="alertdialog"]')) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      layer.dispose();
    };
  }, [open, router]);
}
