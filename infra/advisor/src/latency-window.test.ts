import { describe, expect, it } from "vitest";

import { LatencyWindow } from "./latency-window.ts";
import { SessionManager } from "./sessions.ts";

describe("LatencyWindow", () => {
  it("reports null stats when empty", () => {
    const w = new LatencyWindow(100);
    expect(w.stats()).toEqual({
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      avgMs: null,
      lastMs: null,
      cached: false,
    });
  });

  it("computes p50/p95/avg/last over the window", () => {
    const w = new LatencyWindow(100);
    for (const ms of [100, 200, 300, 400, 500]) w.record(ms);
    const s = w.stats();
    expect(s.sampleCount).toBe(5);
    expect(s.p50Ms).toBe(300); // nearest-rank median
    expect(s.p95Ms).toBe(500);
    expect(s.avgMs).toBe(300);
    expect(s.lastMs).toBe(500);
  });

  it("rolls off the oldest sample past capacity", () => {
    const w = new LatencyWindow(3);
    w.record(1000);
    w.record(10);
    w.record(20);
    w.record(30); // evicts 1000
    const s = w.stats();
    expect(s.sampleCount).toBe(3);
    expect(s.lastMs).toBe(30);
    // 1000 is gone, so the median is small — proves the window slid.
    expect(s.p50Ms).toBe(20);
  });

  it("drops non-finite / negative samples (clock skew must not poison the median)", () => {
    const w = new LatencyWindow(100);
    w.record(50);
    w.record(-5);
    w.record(Number.NaN);
    w.record(Number.POSITIVE_INFINITY);
    w.record(150);
    const s = w.stats();
    expect(s.sampleCount).toBe(2);
    expect(s.avgMs).toBe(100);
  });

  it("flags hydrated samples as cached until a live sample lands", () => {
    const w = new LatencyWindow(100);
    w.hydrate([100, 200, 300]);
    // Served straight from the disk snapshot: real percentiles, marked cached.
    const before = w.stats();
    expect(before.sampleCount).toBe(3);
    expect(before.p50Ms).toBe(200);
    expect(before.cached).toBe(true);
    // One fresh sample flips it to live (even while old samples remain).
    w.record(400);
    const after = w.stats();
    expect(after.sampleCount).toBe(4);
    expect(after.cached).toBe(false);
  });

  it("hydrate honors capacity and validation, and snapshot round-trips", () => {
    const w = new LatencyWindow(3);
    // Five offered, only the last 3 kept; the negative is dropped first.
    w.hydrate([-1, 10, 20, 30, 40]);
    expect(w.snapshot()).toEqual([20, 30, 40]);
    expect(w.stats().sampleCount).toBe(3);
  });

  it("snapshot reflects live records and can re-seed a fresh window", () => {
    const a = new LatencyWindow(100);
    for (const ms of [100, 200, 300]) a.record(ms);
    const snap = a.snapshot();
    const b = new LatencyWindow(100);
    b.hydrate(snap);
    // Same numbers survive the round-trip, but the re-seeded window is cached.
    expect(b.stats().p50Ms).toBe(a.stats().p50Ms);
    expect(b.stats().cached).toBe(true);
  });
});

describe("SessionManager onFirstChunk (TTFT)", () => {
  // A minimal ServerResponse stub — write/end/setHeader/flushHeaders are
  // all the SessionManager touches.
  function fakeRes() {
    const res = {
      statusCode: 0,
      writableEnded: false,
      setHeader() {},
      flushHeaders() {},
      write() {
        return true;
      },
      end() {
        res.writableEnded = true;
      },
    };
    return res as unknown as import("node:http").ServerResponse;
  }

  it("fires once, on the FIRST chunk, with received → first-chunk elapsed", () => {
    const samples: number[] = [];
    const sessions = new SessionManager({ onFirstChunk: (ms) => samples.push(ms) });
    const receivedAt = Date.now() - 120; // request arrived 120ms ago
    sessions.open("s1", "did:plc:p", "m1", "did:plc:req", fakeRes(), receivedAt);

    sessions.write("s1", { type: "chunk", sessionId: "s1", seq: 0, ciphertext: [1] });
    sessions.write("s1", { type: "chunk", sessionId: "s1", seq: 1, ciphertext: [2] });

    // One sample only (first chunk), and it reflects the received→first gap.
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeGreaterThanOrEqual(110);
    expect(samples[0]).toBeLessThan(2_000);
  });

  it("does not fire when a session completes without ever streaming a chunk", () => {
    const samples: number[] = [];
    const sessions = new SessionManager({ onFirstChunk: (ms) => samples.push(ms) });
    sessions.open("s2", "did:plc:p", "m1", "did:plc:req", fakeRes(), Date.now());
    sessions.complete("s2", { tokensIn: 1, tokensOut: 0, receiptUri: "at://x" });
    expect(samples.length).toBe(0);
  });
});
