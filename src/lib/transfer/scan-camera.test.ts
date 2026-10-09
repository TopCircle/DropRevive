import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cameraConstraints,
  prepareCamera,
  setTorch,
  tapFocus,
  tapPoint,
  viewfinderAspect,
  type CameraTrack,
} from "./scan-camera.ts";

function fakeTrack(
  capabilities: unknown,
  options: { reject?: boolean } = {},
): CameraTrack & { applied: unknown[] } {
  const applied: unknown[] = [];
  return {
    applied,
    getCapabilities: () => capabilities,
    applyConstraints: async (constraints) => {
      if (options.reject) throw new Error("OverconstrainedError");
      applied.push(constraints);
    },
  };
}

const noWait = async () => {};

describe("cameraConstraints", () => {
  it("asks for the back camera at 1280x720 and 30 fps as ideals", () => {
    assert.deepEqual(cameraConstraints(), {
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
  });
});

describe("prepareCamera", () => {
  it("applies continuous focus only when the camera lists it", async () => {
    const yes = fakeTrack({ focusMode: ["manual", "continuous"] });
    await prepareCamera(yes);
    assert.deepEqual(yes.applied, [{ advanced: [{ focusMode: "continuous" }] }]);
    const no = fakeTrack({ focusMode: ["manual"] });
    await prepareCamera(no);
    assert.deepEqual(no.applied, []);
  });

  it("shows the torch only when the camera reports it", async () => {
    assert.deepEqual(await prepareCamera(fakeTrack({ torch: true })), { torch: true });
    assert.deepEqual(await prepareCamera(fakeTrack({ torch: false })), { torch: false });
    assert.deepEqual(await prepareCamera(fakeTrack({})), { torch: false });
  });

  it("swallows errors from missing, throwing and rejecting cameras", async () => {
    assert.deepEqual(await prepareCamera({ applyConstraints: async () => {} }), { torch: false });
    const throwing: CameraTrack = {
      getCapabilities: () => {
        throw new Error("nope");
      },
      applyConstraints: async () => {},
    };
    assert.deepEqual(await prepareCamera(throwing), { torch: false });
    const rejecting = fakeTrack({ focusMode: ["continuous"], torch: true }, { reject: true });
    assert.deepEqual(await prepareCamera(rejecting), { torch: true });
  });

  it("ignores junk capability shapes", async () => {
    assert.deepEqual(await prepareCamera(fakeTrack({ focusMode: "continuous", torch: "yes" })), {
      torch: false,
    });
    assert.deepEqual(await prepareCamera(fakeTrack(null)), { torch: false });
  });
});

describe("setTorch", () => {
  it("applies the torch constraint and reports success", async () => {
    const track = fakeTrack({ torch: true });
    assert.equal(await setTorch(track, true), true);
    assert.equal(await setTorch(track, false), true);
    assert.deepEqual(track.applied, [
      { advanced: [{ torch: true }] },
      { advanced: [{ torch: false }] },
    ]);
  });

  it("reports false instead of throwing when the camera refuses", async () => {
    assert.equal(await setTorch(fakeTrack({ torch: true }, { reject: true }), true), false);
  });
});

describe("tapFocus", () => {
  it("does nothing when no focus control is supported", async () => {
    const track = fakeTrack({ focusMode: ["continuous"] });
    assert.equal(await tapFocus(track, { x: 0.5, y: 0.5 }, { sleep: noWait }), false);
    assert.deepEqual(track.applied, []);
  });

  it("focuses once at the point, then returns to continuous", async () => {
    const track = fakeTrack({ focusMode: ["single-shot", "continuous"] });
    assert.equal(
      await tapFocus(track, { x: 0.25, y: 0.75 }, { pointsOfInterest: true, sleep: noWait }),
      true,
    );
    assert.deepEqual(track.applied, [
      { advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: 0.25, y: 0.75 }] }] },
      { advanced: [{ focusMode: "continuous" }] },
    ]);
  });

  it("falls back to manual focus and clamps the point", async () => {
    const track = fakeTrack({ focusMode: ["manual"] });
    assert.equal(await tapFocus(track, { x: 2, y: -1 }, { sleep: noWait }), true);
    assert.deepEqual(track.applied, [{ advanced: [{ focusMode: "manual" }] }]);
  });

  it("uses a focus point alone when the browser only supports that", async () => {
    const track = fakeTrack({});
    assert.equal(
      await tapFocus(track, { x: 0.1, y: 0.2 }, { pointsOfInterest: true, sleep: noWait }),
      true,
    );
    assert.deepEqual(track.applied, [{ advanced: [{ pointsOfInterest: [{ x: 0.1, y: 0.2 }] }] }]);
  });

  it("swallows a refusal and does not try to restore focus", async () => {
    const track = fakeTrack({ focusMode: ["single-shot", "continuous"] }, { reject: true });
    assert.equal(await tapFocus(track, { x: 0.5, y: 0.5 }, { sleep: noWait }), false);
  });
});

describe("viewfinderAspect", () => {
  it("gives a portrait feed the 1:1 floor so the box stays wide", () => {
    assert.equal(viewfinderAspect(720, 1280), 1);
    assert.equal(viewfinderAspect(480, 640), 1);
  });
  it("keeps 16:9, 4:3 and 1:1 feeds as they are", () => {
    assert.equal(viewfinderAspect(1280, 720), 16 / 9);
    assert.equal(viewfinderAspect(640, 480), 4 / 3);
    assert.equal(viewfinderAspect(720, 720), 1);
  });
  it("caps very wide feeds and defaults to 1 without a size", () => {
    assert.equal(viewfinderAspect(3000, 500), 16 / 9);
    assert.equal(viewfinderAspect(0, 0), 1);
    assert.equal(viewfinderAspect(Number.NaN, 720), 1);
  });
});

describe("tapPoint", () => {
  const near = (actual: { x: number; y: number }, x: number, y: number) => {
    assert.ok(
      Math.abs(actual.x - x) < 1e-9 && Math.abs(actual.y - y) < 1e-9,
      `${JSON.stringify(actual)} != ${x},${y}`,
    );
  };
  it("is a plain fraction of the box when the shapes match", () => {
    const box = { left: 10, top: 20, width: 300, height: 400 };
    near(tapPoint(box, { width: 600, height: 800 }, { x: 160, y: 220 }), 0.5, 0.5);
    near(tapPoint(box, { width: 600, height: 800 }, { x: 10, y: 20 }), 0, 0);
    near(tapPoint(box, { width: 600, height: 800 }, { x: 310, y: 420 }), 1, 1);
  });
  it("undoes the cover crop on a 9:16 feed in a 3:4 box (top and bottom cut)", () => {
    const box = { left: 0, top: 0, width: 300, height: 400 };
    const video = { width: 720, height: 1280 };
    // The picture is shown 300x533.3; 66.7 px is hidden above and below.
    near(tapPoint(box, video, { x: 150, y: 200 }), 0.5, 0.5);
    near(tapPoint(box, video, { x: 0, y: 0 }), 0, 66.6666666667 / 533.3333333333);
    near(tapPoint(box, video, { x: 300, y: 400 }), 1, 1 - 66.6666666667 / 533.3333333333);
  });
  it("undoes the bigger crop of a 9:16 feed in a square box", () => {
    const box = { left: 10, top: 10, width: 300, height: 300 };
    const video = { width: 720, height: 1280 };
    near(tapPoint(box, video, { x: 160, y: 160 }), 0.5, 0.5);
    near(tapPoint(box, video, { x: 10, y: 10 }), 0, 0.21875);
    near(tapPoint(box, video, { x: 310, y: 310 }), 1, 0.78125);
  });
  it("undoes the crop sideways when the box is taller than the feed", () => {
    const box = { left: 0, top: 0, width: 300, height: 300 };
    near(tapPoint(box, { width: 1200, height: 600 }, { x: 150, y: 150 }), 0.5, 0.5);
    near(tapPoint(box, { width: 1200, height: 600 }, { x: 0, y: 150 }), 0.25, 0.5);
  });
  it("clamps taps outside the box and copes with an unknown feed size", () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    near(tapPoint(box, { width: 100, height: 100 }, { x: -50, y: 500 }), 0, 1);
    near(tapPoint(box, { width: 0, height: 0 }, { x: 25, y: 75 }), 0.25, 0.75);
  });
});
