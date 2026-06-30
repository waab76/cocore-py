// Tests for the relay supervisor's reconnect contract.
//
// The 2026-06 indexer stall: the supervised reconnect only retried on
// FAILURE, but @atproto/sync's start() RESOLVES on a clean upstream end
// (server close / idle cutoff). A clean end therefore silently completed the
// supervisor fiber and the relay never reconnected, starving the store.
// `superviseRelay` fixes that by turning a clean completion into a retryable
// failure. These tests pin both reconnect paths deterministically (no socket,
// no real backoff) via Schedule.recurs.

import { describe, expect, it } from "vitest";
import { Effect, Schedule } from "effect";

import { RelayStreamEnded, superviseRelay } from "./relay-firehose.ts";

describe("superviseRelay", () => {
  it("reconnects after a CLEAN stream end (the bug: success used to stop the fiber)", async () => {
    let attempts = 0;
    // connect resolves cleanly every time — simulates a graceful upstream EOF.
    const connect = () =>
      Effect.sync(() => {
        attempts += 1;
      });
    // recurs(3) = initial attempt + 3 retries, then give up.
    await Effect.runPromise(Effect.either(superviseRelay(connect, Schedule.recurs(3))));
    expect(attempts).toBe(4);
  });

  it("reconnects after a drop (error) too", async () => {
    let attempts = 0;
    const connect = () =>
      Effect.failSync(() => {
        attempts += 1;
        return new Error("subscription dropped");
      });
    await Effect.runPromise(Effect.either(superviseRelay(connect, Schedule.recurs(2))));
    expect(attempts).toBe(3);
  });

  it("invokes onAttemptEnd for each terminated attempt, flagging clean ends", async () => {
    const ends: string[] = [];
    let attempts = 0;
    const connect = () =>
      Effect.sync(() => {
        attempts += 1;
      });
    await Effect.runPromise(
      Effect.either(
        superviseRelay(connect, Schedule.recurs(2), (err) => {
          ends.push(err instanceof RelayStreamEnded ? "ended" : "error");
        }),
      ),
    );
    // initial + 2 retries = 3 terminated attempts, all clean ends.
    expect(ends).toEqual(["ended", "ended", "ended"]);
  });
});
