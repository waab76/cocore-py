// Tests for the OpenAI-shaped error mapping + buffered response
// drainer. The streaming path is exercised end-to-end through the
// route handlers; these tests cover the pure functions so we can
// iterate on the error vocabulary without standing up a dispatcher.

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import type { DispatchErrorCode, DispatchEvent } from "./inference-dispatch.server.ts";
import {
  bufferedResponse,
  dispatchErrorToHttpResponse,
  normalizeMessageContent,
  parseRequest,
} from "./openai-chat-completions.server.ts";

describe("normalizeMessageContent", () => {
  test("passes through plain strings", () => {
    assert.equal(normalizeMessageContent("hello"), "hello");
  });

  test("extracts text from OpenAI-style content parts", () => {
    assert.equal(
      normalizeMessageContent([
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ]),
      "line one\nline two",
    );
  });

  test("treats null/undefined as empty", () => {
    assert.equal(normalizeMessageContent(null), "");
    assert.equal(normalizeMessageContent(undefined), "");
  });

  test("rejects non-text parts when no text is present", () => {
    assert.equal(normalizeMessageContent([{ type: "image_url", image_url: { url: "x" } }]), null);
  });
});

describe("parseRequest", () => {
  test("accepts Cursor/OpenAI array message content", () => {
    const parsed = parseRequest({
      model: "stub",
      messages: [{ role: "user", content: [{ type: "text", text: "hello from cursor" }] }],
    });
    assert.notEqual(typeof parsed, "string");
    if (typeof parsed === "string") return;
    assert.equal(parsed.messages[0]!.content, "hello from cursor");
  });
});

describe("dispatchErrorToHttpResponse", () => {
  test("no-providers-for-model becomes 404 model_not_found", () => {
    const out = dispatchErrorToHttpResponse("no-providers-for-model");
    assert.equal(out.status, 404);
    assert.equal(out.type, "invalid_request_error");
    assert.equal(out.code, "model_not_found");
  });

  test("no-friends-for-model also becomes 404 with its own code", () => {
    const out = dispatchErrorToHttpResponse("no-friends-for-model");
    assert.equal(out.status, 404);
    assert.equal(out.code, "no_friends_for_model");
  });

  test("no-friends-available becomes 503 service_unavailable_error", () => {
    const out = dispatchErrorToHttpResponse("no-friends-available");
    assert.equal(out.status, 503);
    assert.equal(out.type, "service_unavailable_error");
    assert.equal(out.code, "no_friends_available");
  });

  test("no-providers-connected becomes 503 with the matching code", () => {
    const out = dispatchErrorToHttpResponse("no-providers-connected");
    assert.equal(out.status, 503);
    assert.equal(out.code, "no_providers_connected");
  });

  test("pipeline failures collapse to 502 server_error with a distinct code", () => {
    for (const code of [
      "pds-publish-failed",
      "provider-encryption-key-malformed",
      "chunk-decrypt-failed",
      "advisor-rejected",
      "advisor-transport",
      "unknown",
    ] as DispatchErrorCode[]) {
      const out = dispatchErrorToHttpResponse(code);
      assert.equal(out.status, 502, `expected 502 for ${code}`);
      assert.equal(out.type, "server_error", `expected server_error type for ${code}`);
    }
  });

  test("provider-payouts-not-eligible becomes 403 permission_error", () => {
    const out = dispatchErrorToHttpResponse("provider-payouts-not-eligible");
    assert.equal(out.status, 403);
    assert.equal(out.type, "permission_error");
  });
});

async function* yieldEvents(events: DispatchEvent[]): AsyncIterable<DispatchEvent> {
  for (const ev of events) yield ev;
}

describe("bufferedResponse error mapping", () => {
  test("happy path: aggregates chunks into a single OpenAI chat completion body", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        { kind: "chunk", seq: 0, text: "hello " },
        { kind: "chunk", seq: 1, text: "world" },
        { kind: "complete", tokensIn: 3, tokensOut: 2, receiptUri: "at://x" },
      ]),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(body.choices[0]!.message.content, "hello world");
    assert.equal(body.usage.prompt_tokens, 3);
    assert.equal(body.usage.completion_tokens, 2);
    assert.equal(body.usage.total_tokens, 5);
  });

  test("provider credit surfaces as an x_cocore block on the completion", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        { kind: "chunk", seq: 0, text: "hi" },
        {
          kind: "complete",
          tokensIn: 1,
          tokensOut: 1,
          receiptUri: "at://did:plc:p/dev.cocore.compute.receipt/1",
          providerCredit: {
            did: "did:plc:p",
            handle: "devingaffney.com",
            displayName: null,
            machineLabel: "Mac-mini.local",
            line: "this completion lovingly created for you by devingaffney.com via their Mac-mini.local server",
          },
        },
      ]),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      x_cocore?: {
        credit?: string;
        receiptUri?: string;
        provider?: { handle?: string; machineLabel?: string };
      };
    };
    assert.ok(body.x_cocore, "expected an x_cocore block");
    assert.match(body.x_cocore!.credit ?? "", /lovingly created for you by devingaffney\.com/);
    assert.equal(body.x_cocore!.provider?.machineLabel, "Mac-mini.local");
    assert.equal(body.x_cocore!.receiptUri, "at://did:plc:p/dev.cocore.compute.receipt/1");
  });

  test("no x_cocore block when the completion carries no provider credit", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        { kind: "chunk", seq: 0, text: "hi" },
        { kind: "complete", tokensIn: 1, tokensOut: 1, receiptUri: "" },
      ]),
    );
    const body = (await res.json()) as { x_cocore?: unknown };
    assert.equal(body.x_cocore, undefined);
  });

  test("no-providers-for-model returns 404 with OpenAI's model_not_found code", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        {
          kind: "error",
          reason: "no connected provider serves model 'stub' (4 providers online overall)",
          code: "no-providers-for-model",
        },
      ]),
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as {
      error: { message: string; type: string; code: string | null };
    };
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "model_not_found");
    assert.match(body.error.message, /stub/);
  });

  test("no-capacity (failover exhausted) returns a clean, retryable 503 with no internals", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        {
          kind: "error",
          reason: "The model is temporarily unavailable. Please retry.",
          code: "no-capacity",
        },
      ]),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      error: { message: string; type: string; code: string | null };
    };
    assert.equal(body.error.type, "service_unavailable_error");
    assert.equal(body.error.code, "model_unavailable");
    // Crucially, the message must NOT leak advisor internals — no provider
    // DID, no "attested", no "preflighted N", no `/jobs 503` plumbing.
    assert.doesNotMatch(body.error.message, /did:plc|attested|preflight|\/jobs|advisor/i);
    assert.match(body.error.message, /temporarily unavailable/i);
  });

  test("no-friends-available returns 503 with no_friends_available code", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        {
          kind: "error",
          reason: "you have no friends; add some at /friends",
          code: "no-friends-available",
        },
      ]),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string | null } };
    assert.equal(body.error.code, "no_friends_available");
  });

  test("error events short-circuit the buffered response (no 200 emitted after)", async () => {
    const res = await bufferedResponse(
      "chatcmpl-id",
      "stub",
      yieldEvents([
        { kind: "chunk", seq: 0, text: "partial" },
        { kind: "error", reason: "boom", code: "advisor-rejected" },
      ]),
    );
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, "boom");
  });
});
