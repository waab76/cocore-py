"use client";

import type { InferenceApiCatalogEntry } from "@/lib/inference-docs/catalog.ts";

import * as stylex from "@stylexjs/stylex";

import { InferenceApiRequestPanel } from "@/components/inference-docs/inference-api-request-panel.tsx";
import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";

function inferenceApiAuthLabel(auth: InferenceApiCatalogEntry["auth"]): string {
  return auth === "required" ? "required" : "none";
}

export function InferenceApiEndpoint({
  entry,
  baseUrl,
  first,
}: {
  entry: InferenceApiCatalogEntry;
  baseUrl: string;
  first?: boolean;
}) {
  const authRequired = entry.auth === "required";

  return (
    <section
      id={entry.id}
      {...stylex.props(docsStyles.endpoint, first && docsStyles.endpointFirst)}
    >
      <div {...stylex.props(docsStyles.endpointGrid)}>
        <div {...stylex.props(docsStyles.endpointLeft)}>
          <div {...stylex.props(docsStyles.nsidRow)}>
            <code {...stylex.props(docsStyles.codeInline)}>{entry.path}</code>
            <span
              {...stylex.props(
                docsStyles.methodBadge,
                entry.method === "GET"
                  ? docsStyles.methodBadgeQuery
                  : docsStyles.methodBadgeProcedure,
              )}
            >
              {entry.method.toLowerCase()}
            </span>
            <span {...stylex.props(docsStyles.authBadge)}>
              <span
                {...stylex.props(docsStyles.authDot, authRequired && docsStyles.authDotRequired)}
              />
              auth: {inferenceApiAuthLabel(entry.auth)}
            </span>
          </div>
          <p {...stylex.props(docsStyles.endpointDesc)}>{entry.description}</p>
          {entry.params.length > 0 ? (
            <table {...stylex.props(docsStyles.paramTable)}>
              <thead>
                <tr>
                  <th {...stylex.props(docsStyles.paramTh)}>Param</th>
                  <th {...stylex.props(docsStyles.paramTh)}>Type</th>
                </tr>
              </thead>
              <tbody>
                {entry.params.map((param) => (
                  <tr key={param.name}>
                    <td {...stylex.props(docsStyles.paramTd)}>
                      <span {...stylex.props(docsStyles.paramName)}>
                        {param.name}
                        {param.required ? (
                          <span {...stylex.props(docsStyles.paramRequired)}>*</span>
                        ) : null}
                      </span>
                    </td>
                    <td {...stylex.props(docsStyles.paramTd)}>
                      <span {...stylex.props(docsStyles.paramType)}>{param.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div {...stylex.props(docsStyles.endpointRight)}>
          <InferenceApiRequestPanel entry={entry} baseUrl={baseUrl} />
        </div>
      </div>
    </section>
  );
}
