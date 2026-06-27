// The `messages-v1` canonical multimodal input envelope.
//
// cocore's inference path historically sealed a single flattened prompt
// string; `inputCommitment` was SHA-256 over those exact bytes. Vision
// models need text AND image input, so a request that carries images
// seals a CANONICAL-JSON envelope instead of a raw string, and the job
// record's `inputFormat` is set to "messages-v1" to say so.
//
// The load-bearing property is unchanged: `inputCommitment` is the hash
// over the EXACT sealed bytes. The requester canonicalizes the envelope
// here and hashes the bytes; the provider opens the same bytes and
// hashes them (provider/src/advisor.rs). Neither side parses the payload
// to compute the commitment, so it stays self-consistent. The envelope
// format only governs how the provider INTERPRETS the opened bytes when
// `inputFormat === "messages-v1"`.
//
// Canonicalization MUST match provider/src/canonical.rs (sorted keys,
// no insignificant whitespace) so a verifier holding the logical input
// can reconstruct the identical bytes and recompute the commitment.

import { canonicalBytes } from "./canonical.ts";

/** Wire value for `dev.cocore.compute.job.inputFormat` when the sealed
 *  bytes are this envelope rather than a raw prompt string. */
export const MESSAGES_V1 = "messages-v1" as const;

/** Schema version carried in the envelope so the provider can reject a
 *  shape it doesn't understand rather than mis-serving it. */
export const ENVELOPE_VERSION = 1 as const;

export interface EnvelopeTextPart {
  type: "text";
  text: string;
}

/** An image part. `data` is the raw image bytes, base64-encoded, carried
 *  inline (no external fetch needed to verify the commitment). `mime` is
 *  the source media type (e.g. "image/png") so the provider can hand a
 *  correct data URI to the engine. */
export interface EnvelopeImagePart {
  type: "image";
  mime: string;
  data: string;
}

export type EnvelopeContentPart = EnvelopeTextPart | EnvelopeImagePart;

/** Message content: a plain string (text-only turn) or an ordered array
 *  of parts (text interleaved with images). */
export type EnvelopeContent = string | EnvelopeContentPart[];

/** A tool call the assistant made — mirrors the OpenAI `tool_calls` shape.
 *  Present on assistant messages that include function calls. */
export interface EnvelopeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface EnvelopeMessage {
  role: string;
  content: EnvelopeContent;
  /** Present on assistant messages that include tool calls. */
  tool_calls?: EnvelopeToolCall[];
  /** Present on tool-role messages (the result of a tool call). */
  tool_call_id?: string;
}

export interface MultimodalEnvelope {
  v: typeof ENVELOPE_VERSION;
  messages: EnvelopeMessage[];
}

/** True when any message carries an image part — i.e. the request must
 *  travel as a messages-v1 envelope rather than the legacy text path. */
export function hasImageParts(messages: EnvelopeMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"),
  );
}

/** True when any message carries tool_calls or tool_call_id — i.e. the
 *  request must travel as a messages-v1 envelope (the legacy flattened
 *  text path can't represent tool round-tripping). */
export function hasToolMessages(messages: EnvelopeMessage[]): boolean {
  return messages.some((m) => m.tool_calls != null || m.tool_call_id != null);
}

/** True when the request needs the messages-v1 envelope rather than the
 *  legacy flattened text path — i.e. it carries images or tool messages. */
export function needsEnvelope(messages: EnvelopeMessage[]): boolean {
  return hasImageParts(messages) || hasToolMessages(messages);
}

/** Canonical bytes of the envelope — the exact payload that gets sealed
 *  and that `inputCommitment` is computed over. Reuses the shared
 *  `canonicalBytes` so the serialization matches the provider byte for
 *  byte. */
export function buildEnvelopeBytes(messages: EnvelopeMessage[]): Uint8Array {
  const envelope: MultimodalEnvelope = { v: ENVELOPE_VERSION, messages };
  return canonicalBytes(envelope as unknown as Record<string, unknown>);
}

/** Parse + minimally validate envelope bytes back into the structured
 *  form. Used by verifiers and tests; the provider has its own Rust
 *  parser. Throws on a malformed or unknown-version envelope. */
export function parseEnvelope(bytes: Uint8Array): MultimodalEnvelope {
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!obj || typeof obj !== "object") throw new Error("envelope is not an object");
  const e = obj as Record<string, unknown>;
  if (e.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version: ${String(e.v)}`);
  if (!Array.isArray(e.messages)) throw new Error("envelope.messages must be an array");
  const messages: EnvelopeMessage[] = e.messages.map((m, i) => {
    if (!m || typeof m !== "object") throw new Error(`message ${i} is not an object`);
    const msg = m as Record<string, unknown>;
    if (typeof msg.role !== "string") throw new Error(`message ${i} role must be a string`);
    return {
      role: msg.role,
      content: parseContent(msg.content, i),
      ...parseToolFields(msg, i),
    };
  });
  return { v: ENVELOPE_VERSION, messages };
}

/** Validate + coerce an untrusted `messages` value (e.g. a JSON request
 *  body) into `EnvelopeMessage[]`. Returns null when it isn't a valid
 *  non-empty array of `{ role, content }` with recognized content parts —
 *  callers turn that into a 400. Unlike {@link parseEnvelope} this takes the
 *  bare messages array (no `{ v, messages }` wrapper), which is the shape a
 *  client sends alongside a flattened prompt. */
export function coerceEnvelopeMessages(value: unknown): EnvelopeMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  try {
    return value.map((m, i) => {
      if (!m || typeof m !== "object") throw new Error(`message ${i} is not an object`);
      const msg = m as Record<string, unknown>;
      if (typeof msg.role !== "string") throw new Error(`message ${i} role must be a string`);
      return {
        role: msg.role,
        content: parseContent(msg.content, i),
        ...parseToolFields(msg, i),
      };
    });
  } catch {
    return null;
  }
}

function parseContent(content: unknown, i: number): EnvelopeContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`message ${i} content must be string or array`);
  return content.map((part, j) => {
    if (!part || typeof part !== "object") throw new Error(`message ${i} part ${j} invalid`);
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      return { type: "text", text: p.text };
    }
    if (p.type === "image" && typeof p.mime === "string" && typeof p.data === "string") {
      return { type: "image", mime: p.mime, data: p.data };
    }
    throw new Error(`message ${i} part ${j} has unknown type`);
  });
}

/** Parse optional `tool_calls` and `tool_call_id` from a message object.
 *  Returns an empty object when neither is present, so the spread into the
 *  message is a no-op for plain text/image messages. */
function parseToolFields(
  msg: Record<string, unknown>,
  i: number,
): { tool_calls?: EnvelopeToolCall[]; tool_call_id?: string } {
  const out: { tool_calls?: EnvelopeToolCall[]; tool_call_id?: string } = {};
  if (msg.tool_call_id !== undefined) {
    if (typeof msg.tool_call_id !== "string")
      throw new Error(`message ${i} tool_call_id must be a string`);
    out.tool_call_id = msg.tool_call_id;
  }
  if (msg.tool_calls !== undefined) {
    if (!Array.isArray(msg.tool_calls)) throw new Error(`message ${i} tool_calls must be an array`);
    out.tool_calls = msg.tool_calls.map((tc, j) => {
      if (!tc || typeof tc !== "object")
        throw new Error(`message ${i} tool_call ${j} is not an object`);
      const t = tc as Record<string, unknown>;
      if (typeof t.id !== "string") throw new Error(`message ${i} tool_call ${j} missing id`);
      if (t.type !== "function")
        throw new Error(`message ${i} tool_call ${j} type must be "function"`);
      const fn = t.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw new Error(`message ${i} tool_call ${j} function must have name and arguments`);
      }
      return {
        id: t.id,
        type: "function" as const,
        function: { name: fn.name, arguments: fn.arguments },
      };
    });
  }
  return out;
}
