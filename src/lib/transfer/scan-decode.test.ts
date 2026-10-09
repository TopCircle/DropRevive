import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  createJsqrDecoder,
  createNativeDecoder,
  createScanEngine,
  decodeSize,
  formatDebug,
  judgeScan,
  scanErrorKey,
  type Decoder,
  type FrameLike,
} from "./scan-decode.ts";

const ORIGIN = "https://drop.example.test";
type Src = { id: number };
const src: Src = { id: 1 };

function decoder(name: "native" | "jsqr", behave: () => Promise<string[]>): Decoder<Src> {
  return { name, decode: behave };
}

describe("decoder selection", () => {
  it("prefers the native decoder when it can be built", async () => {
    const engine = createScanEngine<Src>({
      native: async () => decoder("native", async () => []),
      jsqr: async () => decoder("jsqr", async () => []),
    });
    assert.equal(await engine.start(), "native");
    assert.equal(engine.info().decoder, "native");
  });

  it("uses jsQR when BarcodeDetector is missing", async () => {
    const engine = createScanEngine<Src>({ jsqr: async () => decoder("jsqr", async () => []) });
    assert.equal(await engine.start(), "jsqr");
  });

  it("falls back to jsQR when the BarcodeDetector constructor throws, and keeps the reason", async () => {
    class Broken {
      constructor() {
        throw new TypeError("qr_code is not supported");
      }
    }
    const engine = createScanEngine<Src>({
      native: () => createNativeDecoder<Src>(Broken as never),
      jsqr: async () => decoder("jsqr", async () => []),
    });
    assert.equal(await engine.start(), "jsqr");
    assert.deepEqual(engine.info().nativeError, {
      name: "TypeError",
      message: "qr_code is not supported",
    });
  });

  it("reports no decoder when jsQR cannot load either", async () => {
    const engine = createScanEngine<Src>({
      jsqr: async () => Promise.reject(new Error("chunk failed")),
    });
    assert.equal(await engine.start(), null);
    assert.equal((await engine.step(src)).dead, true);
  });

  it("native decoder reads rawValue strings and drops empty ones", async () => {
    const native = await createNativeDecoder<Src>(
      class {
        async detect() {
          return [{ rawValue: "a" }, {}, { rawValue: "" }, { rawValue: "b" }];
        }
      } as never,
    );
    assert.deepEqual(await native.decode(src), ["a", "b"]);
    await assert.rejects(createNativeDecoder<Src>(undefined));
  });
});

describe("fallback switching", () => {
  function setup(clock: { t: number }) {
    let nativeCalls = 0;
    let mode: "fail" | "empty" | "read" = "fail";
    const engine = createScanEngine<Src>(
      {
        native: async () =>
          decoder("native", async () => {
            nativeCalls += 1;
            if (mode === "fail")
              throw new DOMException("Barcode Detection Service unavailable", "NotSupportedError");
            return mode === "read" ? ["x"] : [];
          }),
        jsqr: async () => decoder("jsqr", async () => ["from-jsqr"]),
      },
      () => clock.t,
    );
    return { engine, setMode: (next: typeof mode) => (mode = next), calls: () => nativeCalls };
  }

  it("switches after 3 failures in a row", async () => {
    const clock = { t: 0 };
    const { engine } = setup(clock);
    await engine.start();
    assert.equal((await engine.step(src)).error?.name, "NotSupportedError");
    await engine.step(src);
    assert.equal(engine.info().decoder, "native");
    const third = await engine.step(src);
    assert.equal(third.dead, false);
    assert.equal(engine.info().decoder, "jsqr");
    assert.equal(engine.info().switchedFromNative, "errors");
    assert.deepEqual((await engine.step(src)).raws, ["from-jsqr"]);
  });

  it("switches after 3 seconds of errors even with few frames", async () => {
    const clock = { t: 1000 };
    const { engine } = setup(clock);
    await engine.start();
    await engine.step(src);
    clock.t += 3100;
    await engine.step(src);
    assert.equal(engine.info().decoder, "jsqr");
  });

  it("a successful frame resets the failure count", async () => {
    const clock = { t: 0 };
    const { engine, setMode } = setup(clock);
    await engine.start();
    await engine.step(src);
    await engine.step(src);
    setMode("read");
    assert.deepEqual((await engine.step(src)).raws, ["x"]);
    setMode("fail");
    await engine.step(src);
    await engine.step(src);
    assert.equal(engine.info().decoder, "native");
  });

  it("swaps a native decoder that never reads anything for jsQR after a quiet spell", async () => {
    const clock = { t: 0 };
    const { engine, setMode } = setup(clock);
    setMode("empty");
    await engine.start();
    clock.t = 5000;
    await engine.step(src);
    assert.equal(engine.info().decoder, "native");
    clock.t = 6100;
    await engine.step(src);
    assert.equal(engine.info().decoder, "jsqr");
    assert.equal(engine.info().switchedFromNative, "quiet");
  });

  it("is dead when the fallback cannot load after native fails", async () => {
    const engine = createScanEngine<Src>({
      native: async () => decoder("native", async () => Promise.reject(new Error("boom"))),
      jsqr: async () => Promise.reject(new Error("offline")),
    });
    await engine.start();
    await engine.step(src);
    await engine.step(src);
    assert.equal((await engine.step(src)).dead, true);
  });
});

describe("judgeScan", () => {
  it("accepts a room link for this origin, any case", () => {
    assert.deepEqual(judgeScan(`${ORIGIN}/?transfer=abcd2345`, ORIGIN), {
      kind: "ok",
      code: "ABCD2345",
    });
  });
  it("names the host of a QR for another site", () => {
    assert.deepEqual(judgeScan("https://other.example/?transfer=ABCD2345", ORIGIN), {
      kind: "other-site",
      host: "other.example",
    });
  });
  it("rejects a bad or missing room code on this origin", () => {
    assert.deepEqual(judgeScan(`${ORIGIN}/?transfer=ABC`, ORIGIN), { kind: "bad-code" });
    assert.deepEqual(judgeScan(`${ORIGIN}/?transfer=ABCD234I`, ORIGIN), { kind: "bad-code" });
    assert.deepEqual(judgeScan(`${ORIGIN}/`, ORIGIN), { kind: "bad-code" });
  });
  it("treats non-URL text as unreadable", () => {
    assert.deepEqual(judgeScan("hello world", ORIGIN), { kind: "unreadable" });
  });
});

describe("scanErrorKey", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });
  it("maps permission, missing camera and everything else", () => {
    assert.equal(scanErrorKey(named("NotAllowedError")), "transfer.scanDenied");
    assert.equal(scanErrorKey(named("SecurityError")), "transfer.scanDenied");
    assert.equal(scanErrorKey(named("NotFoundError")), "transfer.scanNoCamera");
    assert.equal(scanErrorKey(named("NotReadableError")), "transfer.scanMissing");
    assert.equal(scanErrorKey("weird"), "transfer.scanMissing");
    assert.equal(scanErrorKey(undefined), "transfer.scanMissing");
  });
});

/** Pixels of the room QR the way the panel shows it: margin 1, width 240, white p-2 box, then the page. */
function panelPixels(page: "light" | "dark"): FrameLike {
  const qr = QRCode.create(`${ORIGIN}/?transfer=ABCD2345`, {});
  const size = qr.modules.size;
  const margin = 1;
  const width = 240;
  const scale = width / (size + margin * 2);
  const symbol = Math.floor((size + margin * 2) * scale);
  const pad = 8;
  const surround = 40;
  const total = symbol + 2 * (pad + surround);
  const data = new Uint8ClampedArray(total * total * 4);
  const bg = page === "light" ? 255 : 28;
  for (let y = 0; y < total; y++) {
    for (let x = 0; x < total; x++) {
      const sx = x - surround - pad;
      const sy = y - surround - pad;
      let value = bg;
      if (sx >= -pad && sy >= -pad && sx < symbol + pad && sy < symbol + pad) value = 255;
      if (sx >= 0 && sy >= 0 && sx < symbol && sy < symbol) {
        const mx = Math.floor(sx / scale) - margin;
        const my = Math.floor(sy / scale) - margin;
        const dark = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(my, mx);
        value = dark ? 0 : 255;
      }
      const at = (y * total + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { data, width: total, height: total };
}

describe("jsQR fallback decoding the app's own QR", () => {
  for (const page of ["light", "dark"] as const) {
    it(`reads it on a ${page} page`, async () => {
      const frame = panelPixels(page);
      const jsqr = createJsqrDecoder<Src>(jsQR, () => frame);
      const [raw] = await jsqr.decode(src);
      assert.equal(raw, `${ORIGIN}/?transfer=ABCD2345`);
      assert.deepEqual(judgeScan(raw ?? "", ORIGIN), { kind: "ok", code: "ABCD2345" });
    });
  }

  it("reads an inverted (light on dark) code through attemptBoth", async () => {
    const frame = panelPixels("light");
    for (let i = 0; i < frame.data.length; i += 4) {
      frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = 255 - (frame.data[i] ?? 0);
    }
    const [raw] = await createJsqrDecoder<Src>(jsQR, () => frame).decode(src);
    assert.equal(raw, `${ORIGIN}/?transfer=ABCD2345`);
  });

  it("returns nothing when there is no picture yet or no code in it", async () => {
    assert.deepEqual(await createJsqrDecoder<Src>(jsQR, () => null).decode(src), []);
    const blank: FrameLike = {
      data: new Uint8ClampedArray(64 * 64 * 4).fill(200),
      width: 64,
      height: 64,
    };
    assert.deepEqual(await createJsqrDecoder<Src>(jsQR, () => blank).decode(src), []);
  });
});

describe("helpers", () => {
  it("downscales wide frames to 640 and leaves small ones alone", () => {
    assert.deepEqual(decodeSize(1280, 720), { width: 640, height: 360 });
    assert.deepEqual(decodeSize(480, 640), { width: 480, height: 640 });
    assert.equal(decodeSize(0, 720), null);
  });

  it("formats the debug panel with every requested field", () => {
    const text = formatDebug({
      hasNative: true,
      secure: true,
      formats: "qr_code",
      info: {
        decoder: "jsqr",
        frames: 12,
        nativeError: { name: "TypeError", message: "bad" },
        lastError: null,
        switchedFromNative: "errors",
      },
      lastRaw: "https://x.test/",
      lastOutcome: "no: other site x.test",
      origin: ORIGIN,
      video: { readyState: 4, paused: false, width: 1280, height: 720 },
      settings: { width: 1280 },
      capabilities: { torch: true },
      userAgent: "UA",
      brands: "Chromium 120",
    });
    for (const part of [
      "BarcodeDetector in window: true",
      "isSecureContext: true",
      "supported formats: qr_code",
      "failed TypeError: bad",
      "decoder: jsqr (switched from native: errors)",
      "frames: 12",
      "last raw: https://x.test/",
      "readyState 4, paused false, 1280x720",
      '"torch":true',
      "brands: Chromium 120",
    ]) {
      assert.ok(text.includes(part), part);
    }
  });
});
