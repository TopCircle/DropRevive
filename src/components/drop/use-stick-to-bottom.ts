import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DropRecord } from "@/lib/drop/types";

/** Chat order for the timeline: oldest at the top, newest at the bottom (desktop stream and phone list). */
export function oldestFirst(items: DropRecord[]): DropRecord[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Changes when the newest item is one this device just added, so sending always shows it. */
export function ownNewestKey(list: DropRecord[], deviceId: string): string {
  const last = list.at(-1);
  return last && deviceId && last.deviceId === deviceId ? last.id : "";
}

/** Within this many px of the end counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 48;

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * The DOM-free core of useStickToBottom. Pinned means "follow the newest item". Only the
 * user moving up unpins it; content growing under a pinned view (sync results, thumbnails,
 * a resized pane) never does, since that leaves scrollTop where it was.
 */
export class BottomPin {
  pinned = true;
  private lastTop = 0;
  private readonly box: () => ScrollBox | null;

  constructor(box: () => ScrollBox | null) {
    this.box = box;
  }

  onScroll(): void {
    const box = this.box();
    if (!box) return;
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX;
    if (nearEnd) this.pinned = true;
    else if (box.scrollTop < this.lastTop) this.pinned = false;
    this.lastTop = box.scrollTop;
  }

  /** Opening, another drive / folder / filter, or this device just sent: show the newest and follow. */
  reset(): void {
    this.pinned = true;
    this.toBottom();
  }

  /** More items or taller content: follow only while pinned. */
  grew(): void {
    if (this.pinned) this.toBottom();
  }

  private toBottom(): void {
    const box = this.box();
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    this.lastTop = box.scrollTop;
  }
}

/**
 * Chat-style scrolling shared by the desktop stream and the phone list. The list opens at
 * the newest item and jumps back there whenever `resetKey` changes (drive, folder, 全部,
 * search, filters) or `jumpKey` changes (this device just sent something). While the view
 * is at the bottom it stays there as items arrive; once the user scrolls up it is left alone.
 */
export function useStickToBottom({ resetKey, jumpKey, count }: { resetKey: string; jumpKey: string; count: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pin] = useState(() => new BottomPin(() => scrollRef.current));

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => pin.onScroll();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [pin]);

  useLayoutEffect(() => {
    pin.reset();
  }, [resetKey, pin]);

  useLayoutEffect(() => {
    if (jumpKey) pin.reset();
  }, [jumpKey, pin]);

  useLayoutEffect(() => {
    pin.grew();
  }, [count, pin]);

  useEffect(() => {
    const node = scrollRef.current;
    const content = contentRef.current;
    if (!node || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pin.grew());
    observer.observe(content);
    observer.observe(node);
    return () => observer.disconnect();
  }, [pin]);

  return { scrollRef, contentRef };
}
