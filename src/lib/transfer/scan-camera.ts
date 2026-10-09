/**
 * Camera setup for the in-page QR scanner. Pure helpers over a minimal track
 * shape so they can be tested without a browser. Everything past getUserMedia
 * is best effort: browsers that lack a capability are ignored, never reported.
 */

export interface CameraTrack {
  getCapabilities?(): unknown;
  // Method syntax on purpose: it keeps MediaStreamTrack assignable to this shape.
  applyConstraints(constraints: unknown): Promise<void>;
}

export interface CameraFeatures {
  /** The track can switch its torch, so the toggle should be shown. */
  torch: boolean;
}

interface Capabilities {
  focusModes: string[];
  torch: boolean;
}

/** Ask for a sharp, steady picture from the back camera; browsers treat `ideal` as a hint. */
export function cameraConstraints(): MediaStreamConstraints {
  return {
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  };
}

function capabilitiesOf(track: CameraTrack): Capabilities {
  try {
    const raw = track.getCapabilities?.() as { focusMode?: unknown; torch?: unknown } | undefined;
    const focusModes = Array.isArray(raw?.focusMode)
      ? raw.focusMode.filter((mode): mode is string => typeof mode === "string")
      : [];
    return { focusModes, torch: raw?.torch === true };
  } catch {
    return { focusModes: [], torch: false };
  }
}

async function applyAdvanced(
  track: CameraTrack,
  constraint: Record<string, unknown>,
): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [constraint] });
    return true;
  } catch {
    return false;
  }
}

/** Turn on continuous autofocus when the camera offers it, and report which controls exist. */
export async function prepareCamera(track: CameraTrack): Promise<CameraFeatures> {
  const caps = capabilitiesOf(track);
  if (caps.focusModes.includes("continuous"))
    await applyAdvanced(track, { focusMode: "continuous" });
  return { torch: caps.torch };
}

/** Switch the torch; returns whether the camera accepted it. */
export function setTorch(track: CameraTrack, on: boolean): Promise<boolean> {
  return applyAdvanced(track, { torch: on });
}

/** True when this browser understands a focus point in constraints. */
export function supportsPointsOfInterest(): boolean {
  try {
    const supported = navigator.mediaDevices?.getSupportedConstraints?.() as
      { pointsOfInterest?: boolean } | undefined;
    return supported?.pointsOfInterest === true;
  } catch {
    return false;
  }
}

const REFOCUS_MS = 1500;

/**
 * Focus once at a tapped point (x and y are 0..1 across the picture), then go back to
 * continuous focus. Does nothing, and reports false, when the camera supports none of
 * single-shot focus, manual focus or a focus point.
 */
export async function tapFocus(
  track: CameraTrack,
  point: { x: number; y: number },
  options: { pointsOfInterest?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const caps = capabilitiesOf(track);
  const mode = caps.focusModes.includes("single-shot")
    ? "single-shot"
    : caps.focusModes.includes("manual")
      ? "manual"
      : null;
  const points = options.pointsOfInterest === true;
  if (!mode && !points) return false;
  const x = Math.min(1, Math.max(0, point.x));
  const y = Math.min(1, Math.max(0, point.y));
  const constraint: Record<string, unknown> = {};
  if (mode) constraint.focusMode = mode;
  if (points) constraint.pointsOfInterest = [{ x, y }];
  const applied = await applyAdvanced(track, constraint);
  if (applied && caps.focusModes.includes("continuous")) {
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await sleep(REFOCUS_MS);
    await applyAdvanced(track, { focusMode: "continuous" });
  }
  return applied;
}

const MIN_ASPECT = 1;
const MAX_ASPECT = 16 / 9;

/** Width / height of the viewfinder box for a feed of this size: the feed's own shape, between 1:1 and 16:9, so a portrait feed gets a wide square-ish box (cropped top and bottom). */
export function viewfinderAspect(videoWidth: number, videoHeight: number): number {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return MIN_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, videoWidth / videoHeight));
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a tap on an object-cover video lands in the picture (0..1 each way). The picture is
 * scaled to cover the box and centred, so the box shows only part of it when the shapes differ.
 */
export function tapPoint(
  box: Box,
  video: { width: number; height: number },
  click: { x: number; y: number },
): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const px = click.x - box.left;
  const py = click.y - box.top;
  if (!(video.width > 0) || !(video.height > 0))
    return { x: clamp(px / box.width), y: clamp(py / box.height) };
  const scale = Math.max(box.width / video.width, box.height / video.height);
  const shownWidth = video.width * scale;
  const shownHeight = video.height * scale;
  return {
    x: clamp((px + (shownWidth - box.width) / 2) / shownWidth),
    y: clamp((py + (shownHeight - box.height) / 2) / shownHeight),
  };
}
