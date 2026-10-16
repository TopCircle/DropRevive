import assert from "node:assert/strict";
import { test } from "node:test";
import { natHint, parseCandidate } from "./diagnostics.ts";

test("one public port per local port is cone-like", () => {
  assert.equal(
    natHint([
      { url: "stun:a", port: 40000, base: 51000 },
      { url: "stun:b", port: 40000, base: 51000 },
    ]),
    "consistent mapping (cone-like)",
  );
});

test("different public ports for the same local port is symmetric", () => {
  assert.match(
    natHint([
      { url: "stun:a", port: 40000, base: 51000 },
      { url: "stun:b", port: 40007, base: 51000 },
    ]),
    /likely symmetric NAT/,
  );
});

test("the same port on two public IPs (multi-exit NAT) is symmetric", () => {
  assert.match(
    natHint([
      { url: "stun:a", address: "203.0.113.7", port: 40000, base: 51000 },
      { url: "stun:b", address: "198.51.100.9", port: 40000, base: 51000 },
    ]),
    /likely symmetric NAT/,
  );
});

test("different local ports are not compared", () => {
  assert.equal(
    natHint([
      { url: "stun:a", port: 40000, base: 51000 },
      { url: "stun:b", port: 40007, base: 52000 },
    ]),
    "consistent mapping (cone-like)",
  );
});

test("no mapping means no STUN answer", () => {
  assert.match(natHint([]), /no STUN server answered/);
});

test("parses a srflx candidate line", () => {
  assert.deepEqual(parseCandidate("candidate:842163049 1 udp 1677729535 203.0.113.7 40000 typ srflx raddr 0.0.0.0 rport 51000 generation 0"), {
    type: "srflx",
    protocol: "udp",
    address: "203.0.113.7",
    port: 40000,
    relatedPort: 51000,
  });
  assert.equal(parseCandidate("garbage"), null);
});
