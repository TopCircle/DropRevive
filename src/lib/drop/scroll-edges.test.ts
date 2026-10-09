import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeFadeMask, sameEdges, scrollEdges } from "./scroll-edges.ts";

test("scrollEdges: a list that fits has nothing hidden", () => {
  assert.deepEqual(scrollEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }), {
    above: false,
    below: false,
  });
});

test("scrollEdges: at the top only the bottom hides content", () => {
  assert.deepEqual(scrollEdges({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 }), {
    above: false,
    below: true,
  });
});

test("scrollEdges: in the middle both edges hide content", () => {
  assert.deepEqual(scrollEdges({ scrollTop: 200, scrollHeight: 900, clientHeight: 400 }), {
    above: true,
    below: true,
  });
});

test("scrollEdges: at the bottom only the top hides content, with sub-pixel slack", () => {
  assert.deepEqual(scrollEdges({ scrollTop: 500, scrollHeight: 900, clientHeight: 400 }), {
    above: true,
    below: false,
  });
  assert.deepEqual(scrollEdges({ scrollTop: 499.5, scrollHeight: 900, clientHeight: 400 }), {
    above: true,
    below: false,
  });
  assert.deepEqual(scrollEdges({ scrollTop: 0.5, scrollHeight: 900, clientHeight: 400 }), {
    above: false,
    below: true,
  });
});

test("sameEdges compares both flags", () => {
  assert.equal(sameEdges({ above: true, below: false }, { above: true, below: false }), true);
  assert.equal(sameEdges({ above: true, below: false }, { above: true, below: true }), false);
});

test("edgeFadeMask: none at rest, a fade only on edges with hidden content", () => {
  assert.equal(edgeFadeMask({ above: false, below: false }), undefined);
  assert.equal(
    edgeFadeMask({ above: true, below: false }),
    "linear-gradient(to bottom, transparent 0, #000 14px, #000 100%)",
  );
  assert.equal(
    edgeFadeMask({ above: false, below: true }),
    "linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%)",
  );
  assert.equal(
    edgeFadeMask({ above: true, below: true }, 12),
    "linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
  );
});
