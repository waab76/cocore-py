import { describe, expect, it } from "vitest";

import {
  buildEnvelopeBytes,
  coerceEnvelopeMessages,
  type EnvelopeMessage,
  hasImageParts,
  MESSAGES_V1,
  parseEnvelope,
} from "./multimodal-envelope.ts";
import { sha256Hex } from "./publish.ts";

// Cross-language parity fixture. The SAME canonical string + SHA-256 are
// asserted on the Rust side (provider/src/engines/mod.rs:
// parse_messages_v1 + the cross_lang fixture), so a divergence in either
// canonicalizer is caught. If you change the envelope shape, update both.
const FIXTURE_MESSAGES: EnvelopeMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "hi" },
      { type: "image", mime: "image/png", data: "aGVsbG8=" },
    ],
  },
];
const FIXTURE_CANONICAL =
  '{"messages":[{"content":[{"text":"hi","type":"text"},{"data":"aGVsbG8=","mime":"image/png","type":"image"}],"role":"user"}],"v":1}';
const FIXTURE_SHA256 = "3378ffa01b3a72e7210272f2a4ea38f2abfb41662cee6ab11cfc3ac20416b449";

describe("multimodal envelope", () => {
  it("serializes to the canonical (sorted-key) bytes", () => {
    const bytes = buildEnvelopeBytes(FIXTURE_MESSAGES);
    expect(new TextDecoder().decode(bytes)).toBe(FIXTURE_CANONICAL);
  });

  it("commitment over the canonical bytes matches the cross-language fixture", async () => {
    const commitment = await sha256Hex(buildEnvelopeBytes(FIXTURE_MESSAGES));
    expect(commitment).toBe(FIXTURE_SHA256);
  });

  it("round-trips through parseEnvelope", () => {
    const parsed = parseEnvelope(buildEnvelopeBytes(FIXTURE_MESSAGES));
    expect(parsed.v).toBe(1);
    expect(parsed.messages).toEqual(FIXTURE_MESSAGES);
  });

  it("detects image parts", () => {
    expect(hasImageParts(FIXTURE_MESSAGES)).toBe(true);
    expect(hasImageParts([{ role: "user", content: "just text" }])).toBe(false);
    expect(hasImageParts([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBe(false);
  });

  it("keeps a string content turn as-is", () => {
    const bytes = buildEnvelopeBytes([{ role: "user", content: "hello" }]);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"messages":[{"content":"hello","role":"user"}],"v":1}',
    );
  });

  it("rejects an unknown envelope version", () => {
    const bad = new TextEncoder().encode('{"v":2,"messages":[]}');
    expect(() => parseEnvelope(bad)).toThrow(/version/);
  });

  it("exports the wire constant", () => {
    expect(MESSAGES_V1).toBe("messages-v1");
  });
});

describe("coerceEnvelopeMessages", () => {
  it("accepts well-formed multimodal turns", () => {
    const out = coerceEnvelopeMessages([
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mime: "image/png", data: "aGVsbG8=" },
        ],
      },
    ]);
    expect(out).not.toBeNull();
    expect(hasImageParts(out!)).toBe(true);
  });

  it("rejects non-arrays, empty arrays, and bad parts", () => {
    expect(coerceEnvelopeMessages("nope")).toBeNull();
    expect(coerceEnvelopeMessages([])).toBeNull();
    expect(coerceEnvelopeMessages([{ role: "user", content: [{ type: "audio" }] }])).toBeNull();
    expect(coerceEnvelopeMessages([{ content: "no role" }])).toBeNull();
  });
});
