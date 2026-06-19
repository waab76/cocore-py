"use client";

import type { InferenceApiCatalogEntry } from "@/lib/inference-docs/catalog.ts";

import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import { Select, SelectItem } from "@/design-system/select";
import { TextField } from "@/design-system/text-field";
import {
  buildInferenceApiCurl,
  buildInferenceApiRequest,
} from "@/lib/inference-docs/build-curl.ts";
import { Play } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { HighlightedCurl, HighlightedJson } from "@/components/docs/docs-highlighted-code.tsx";
import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";

type ExampleResult = {
  status: number;
  bodyJson: string;
  durationMs: number;
  fetchedAt: string;
};

function initialControlValues(entry: InferenceApiCatalogEntry): Record<string, string> {
  const values: Record<string, string> = {};
  if (entry.id === "inference-api-models") {
    values.view = "default";
  }
  if (entry.method === "POST") {
    values.model = String(entry.example.body?.model ?? "stub");
    const messages = entry.example.body?.messages as Array<{ content?: string }> | undefined;
    values.message = String(messages?.[0]?.content ?? "Hello");
    values.max_tokens = String(entry.example.body?.max_tokens ?? 256);
  }
  return values;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

async function runInferenceExample(
  entry: InferenceApiCatalogEntry,
  baseUrl: string,
  values: Record<string, string>,
  apiKey?: string,
): Promise<ExampleResult> {
  const started = performance.now();
  const { url, init } = buildInferenceApiRequest(entry, baseUrl, values, apiKey);
  const res = await fetch(url, init);
  const bodyJson = await res.text();
  return {
    status: res.status,
    bodyJson,
    durationMs: Math.round(performance.now() - started),
    fetchedAt: new Date().toISOString(),
  };
}

export const InferenceApiRequestPanel = memo(function InferenceApiRequestPanel({
  entry,
  baseUrl,
}: {
  entry: InferenceApiCatalogEntry;
  baseUrl: string;
}) {
  const [paramValues, setParamValues] = useState(() => initialControlValues(entry));
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<ExampleResult | undefined>();
  const [copied, setCopied] = useState(false);

  const curl = useMemo(
    () =>
      buildInferenceApiCurl(entry, baseUrl, paramValues, {
        apiKeyPlaceholder: entry.auth === "required",
      }),
    [entry, baseUrl, paramValues],
  );

  const canRun = entry.example.canRun ?? (entry.auth === "none" && entry.method === "GET");

  const canRunWithKey =
    entry.auth === "required" && entry.method === "POST" && apiKey.trim().length > 0;

  const { mutate, isPending } = useMutation({
    mutationFn: () => runInferenceExample(entry, baseUrl, paramValues, apiKey.trim() || undefined),
    onSuccess: (data) => setResult(data),
  });

  const onCopy = useCallback(() => {
    void copyText(curl);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1400);
  }, [curl]);

  const onParamChange = useCallback((param: string, value: string) => {
    setParamValues((current) => ({ ...current, [param]: value }));
    setResult(undefined);
  }, []);

  const ok = result != null && result.status >= 200 && result.status < 300;

  return (
    <div {...stylex.props(docsStyles.reqPanel)}>
      <div {...stylex.props(docsStyles.reqBar)}>
        <span {...stylex.props(docsStyles.reqTag)}>curl</span>
        <span {...stylex.props(docsStyles.reqSpacer)} />
        <button type="button" {...stylex.props(docsStyles.reqBtn)} onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
        {canRun || canRunWithKey ? (
          <button
            type="button"
            disabled={isPending || (entry.auth === "required" && !canRunWithKey)}
            {...stylex.props(
              docsStyles.reqBtn,
              docsStyles.reqBtnSolid,
              (isPending || (entry.auth === "required" && !canRunWithKey)) &&
                docsStyles.reqBtnDisabled,
            )}
            onClick={() => mutate()}
          >
            {isPending ? (
              <span {...stylex.props(docsStyles.spin)} aria-hidden />
            ) : (
              <Play size={11} fill="currentColor" strokeWidth={0} />
            )}
            {isPending ? "Running" : result ? "Re-run" : "Run example"}
          </button>
        ) : null}
      </div>

      {entry.auth === "required" || entry.controls.length > 0 ? (
        <div {...stylex.props(docsStyles.reqParams)}>
          {entry.auth === "required" ? (
            <>
              <span {...stylex.props(docsStyles.reqParamLabel)}>API key</span>
              <TextField
                aria-label="API key"
                placeholder="cocore-…"
                size="md"
                style={docsStyles.reqParamControl}
                type="password"
                value={apiKey}
                variant="secondary"
                onChange={(value) => {
                  setApiKey(value);
                  setResult(undefined);
                }}
              />
            </>
          ) : null}
          {entry.controls.map((control) => {
            const label = control.label ?? control.param;
            if (control.kind === "select") {
              return (
                <div key={control.param} {...stylex.props(docsStyles.reqParamRow)}>
                  <span {...stylex.props(docsStyles.reqParamLabel)}>{label}</span>
                  <Select
                    aria-label={label}
                    items={control.options}
                    selectedKey={paramValues[control.param] ?? "default"}
                    size="md"
                    style={docsStyles.reqParamControl}
                    variant="secondary"
                    onSelectionChange={(key) => {
                      if (key == null) return;
                      onParamChange(control.param, String(key));
                    }}
                  >
                    {(item) => (
                      <SelectItem id={item.id} textValue={item.label}>
                        {item.label}
                      </SelectItem>
                    )}
                  </Select>
                </div>
              );
            }

            return (
              <div key={control.param} {...stylex.props(docsStyles.reqParamRow)}>
                <span {...stylex.props(docsStyles.reqParamLabel)}>{label}</span>
                <TextField
                  aria-label={label}
                  placeholder={control.placeholder}
                  size="md"
                  style={docsStyles.reqParamControl}
                  value={paramValues[control.param] ?? ""}
                  variant="secondary"
                  onChange={(value) => onParamChange(control.param, value)}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      <HighlightedCurl curl={curl} />

      <div {...stylex.props(docsStyles.respBar)}>
        <span {...stylex.props(docsStyles.reqTag)}>response</span>
        {result != null || isPending ? (
          <span
            {...stylex.props(ok || isPending ? docsStyles.respStatusOk : docsStyles.respStatusErr)}
          >
            {isPending ? "· · ·" : `HTTP ${result?.status ?? ""}`}
          </span>
        ) : null}
      </div>

      {result != null || isPending ? (
        <p {...stylex.props(docsStyles.respMeta)} aria-live="polite">
          {isPending
            ? "running…"
            : `${result?.durationMs ?? 0}ms · fetched ${result?.fetchedAt ?? ""}`}
        </p>
      ) : null}

      {result == null ? (
        isPending ? null : (
          <p {...stylex.props(docsStyles.respEmpty)}>
            {entry.auth === "required"
              ? "Paste an API key above, then run the example."
              : "Click Run example to fetch a live response."}
          </p>
        )
      ) : (
        <HighlightedJson json={result.bodyJson} pending={isPending} />
      )}
    </div>
  );
});
