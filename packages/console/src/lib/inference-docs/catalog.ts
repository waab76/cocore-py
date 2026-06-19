export type InferenceApiAuth = "none" | "required";

export type InferenceApiParamControl =
  | { kind: "text"; param: string; label?: string; placeholder?: string }
  | {
      kind: "select";
      param: string;
      label?: string;
      options: Array<{ id: string; label: string }>;
    };

export type InferenceApiCatalogEntry = {
  id: string;
  navLabel: string;
  method: "GET" | "POST";
  path: string;
  description: string;
  auth: InferenceApiAuth;
  params: Array<{ name: string; type: string; required?: boolean }>;
  controls: Array<InferenceApiParamControl>;
  example: {
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    /** Defaults to true for unauthenticated GET endpoints. */
    canRun?: boolean;
  };
};

const CHAT_BODY = {
  model: "stub",
  messages: [{ role: "user", content: "Hello" }],
  stream: false,
  max_tokens: 256,
};

export const INFERENCE_API_CATALOG: Array<InferenceApiCatalogEntry> = [
  {
    id: "inference-api-chat-completions",
    navLabel: "chat/completions",
    method: "POST",
    path: "/chat/completions",
    description:
      "OpenAI-compatible chat completion. Routes to an attested provider serving the requested model.",
    auth: "required",
    params: [
      { name: "model", type: "string", required: true },
      { name: "messages", type: "array", required: true },
      { name: "stream", type: "boolean" },
      { name: "max_tokens", type: "integer" },
    ],
    controls: [
      { kind: "text", param: "model", label: "model", placeholder: "stub" },
      {
        kind: "text",
        param: "message",
        label: "user message",
        placeholder: "Hello",
      },
      { kind: "text", param: "max_tokens", label: "max_tokens", placeholder: "256" },
    ],
    example: { body: CHAT_BODY, canRun: false },
  },
  {
    id: "inference-api-models",
    navLabel: "models",
    method: "GET",
    path: "/models",
    description:
      "Public model directory. Default response matches OpenAI's list shape; use view for co/core-specific detail.",
    auth: "none",
    params: [{ name: "view", type: "string", required: false }],
    controls: [
      {
        kind: "select",
        param: "view",
        label: "view",
        options: [
          { id: "default", label: "openai (default)" },
          { id: "summary", label: "summary" },
          { id: "directory", label: "directory" },
        ],
      },
    ],
    example: { query: {}, canRun: true },
  },
  {
    id: "inference-api-private-chat-completions",
    navLabel: "private/chat/completions",
    method: "POST",
    path: "/private/chat/completions",
    description:
      "Same request shape as chat/completions, but routing is limited to providers run by DIDs on your friends list.",
    auth: "required",
    params: [
      { name: "model", type: "string", required: true },
      { name: "messages", type: "array", required: true },
      { name: "stream", type: "boolean" },
      { name: "max_tokens", type: "integer" },
    ],
    controls: [
      { kind: "text", param: "model", label: "model", placeholder: "stub" },
      {
        kind: "text",
        param: "message",
        label: "user message",
        placeholder: "Hello",
      },
      { kind: "text", param: "max_tokens", label: "max_tokens", placeholder: "256" },
    ],
    example: { body: CHAT_BODY, canRun: false },
  },
];

export const INFERENCE_API_ERROR_SECTIONS = [
  {
    id: "inference-api-dispatch-errors",
    navLabel: "errors/dispatch",
    title: "Dispatch errors",
    description: "Returned when the exchange cannot place your request with a provider.",
  },
  {
    id: "inference-api-http-errors",
    navLabel: "errors/http",
    title: "HTTP errors",
    description: "Authentication, validation, and upstream failure responses.",
  },
] as const;
