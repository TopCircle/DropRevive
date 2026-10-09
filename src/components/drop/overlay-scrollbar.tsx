import { useEffect, useRef, type RefObject } from "react";
import { EDGE_PX, ThumbVisibility, dragScrollTop, thumbGeometry } from "@/components/drop/overlay-scrollbar-core";

/**
 * Desktop stream scrollbar in the style of chat apps: a thin rounded thumb over a track that
 * runs the full height of the pane (under the header and composer), taking no layout width.
 * It shows while scrolling, near the right edge and while dragging, and fades out a second
 * after. The scroller keeps native wheel / keyboard / touchpad scrolling; only its own
 * scrollbar is hidden. Place inside the scroller's positioned parent.
 */
export function OverlayScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const host = track?.parentElement;
    if (!node || !track || !thumb || !host) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const geometry = thumbGeometry(node);
      thumb.style.height = `${geometry.size}px`;
      thumb.style.transform = `translateY(${geometry.offset}px)`;
      track.dataset.scrollable = String(geometry.scrollable);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const visibility = new ThumbVisibility(
      (visible) => {
        track.dataset.visible = String(visible);
      },
      { set: (run, ms) => window.setTimeout(run, ms), clear: (handle) => window.clearTimeout(handle as number) },
    );

    const onScroll = () => {
      schedule();
      visibility.scrolled();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);

    const onHostMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      visibility.hover(event.clientX >= host.getBoundingClientRect().right - EDGE_PX);
    };
    const onHostLeave = () => visibility.hover(false);

    let drag: { id: number; y: number; top: number } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, y: event.clientY, top: node.scrollTop };
      track.dataset.dragging = "true";
      visibility.drag(true);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      node.scrollTop = dragScrollTop(drag.top, event.clientY - drag.y, node);
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      track.dataset.dragging = "false";
      visibility.drag(false);
    };
    // The thumb sits outside the scroller, so pass wheel turns over it on.
    const onWheel = (event: WheelEvent) => {
      node.scrollTop += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    };

    node.addEventListener("scroll", onScroll, { passive: true });
    host.addEventListener("pointermove", onHostMove);
    host.addEventListener("pointerleave", onHostLeave);
    thumb.addEventListener("pointerdown", onDown);
    thumb.addEventListener("pointermove", onMove);
    thumb.addEventListener("pointerup", onUp);
    thumb.addEventListener("pointercancel", onUp);
    thumb.addEventListener("wheel", onWheel, { passive: true });
    paint();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      visibility.dispose();
      resize.disconnect();
      node.removeEventListener("scroll", onScroll);
      host.removeEventListener("pointermove", onHostMove);
      host.removeEventListener("pointerleave", onHostLeave);
      thumb.removeEventListener("pointerdown", onDown);
      thumb.removeEventListener("pointermove", onMove);
      thumb.removeEventListener("pointerup", onUp);
      thumb.removeEventListener("pointercancel", onUp);
      thumb.removeEventListener("wheel", onWheel);
    };
  }, [scrollRef]);

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-scroll-track=""
      data-visible="false"
      data-scrollable="false"
      data-dragging="false"
      className="group/track pointer-events-none absolute inset-y-0 right-0 z-30 w-3 data-[scrollable=false]:hidden"
    >
      <div
        ref={thumbRef}
        data-scroll-thumb=""
        className="pointer-events-auto absolute top-0 right-[3px] w-1.5 touch-none rounded-full bg-foreground/30 opacity-0 transition-[opacity,width,background-color] duration-300 hover:w-2 hover:bg-foreground/45 group-data-[dragging=true]/track:w-2 group-data-[dragging=true]/track:bg-foreground/50 group-data-[visible=true]/track:opacity-100 motion-reduce:transition-none"
      />
    </div>
  );
}
