"use client";

import type { ApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import type { ApiDocsTagOption } from "@/lib/api-docs/types.ts";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { getSessionQueryOptions } from "@/integrations/auth/session.functions.ts";
import { createContext, useContext, useMemo } from "react";

export type ApiDocsPageContextValue = {
  fixtures: ApiDocsFixtures;
  tagOptions: Array<ApiDocsTagOption>;
  signedIn: boolean;
  sessionDid: string | null;
  /** Server-resolved public console origin for curl examples (the console
   *  reverse-proxies `/xrpc/*` to the AppView). */
  consoleBaseUrl: string;
  /** Server-resolved AppView service DID. */
  appviewDid: string;
};

const ApiDocsPageContext = createContext<ApiDocsPageContextValue | null>(null);

export function ApiDocsPageProvider({
  fixtures,
  tagOptions,
  consoleBaseUrl,
  appviewDid,
  children,
}: {
  fixtures: ApiDocsFixtures;
  tagOptions: Array<ApiDocsTagOption>;
  consoleBaseUrl: string;
  appviewDid: string;
  children: ReactNode;
}) {
  const { data: session } = useQuery(getSessionQueryOptions);
  const sessionDid = session?.user?.did ?? null;
  const value = useMemo(
    () => ({
      fixtures,
      tagOptions,
      signedIn: Boolean(sessionDid),
      sessionDid,
      consoleBaseUrl,
      appviewDid,
    }),
    [fixtures, tagOptions, sessionDid, consoleBaseUrl, appviewDid],
  );

  return <ApiDocsPageContext.Provider value={value}>{children}</ApiDocsPageContext.Provider>;
}

export function useApiDocsPageContext(): ApiDocsPageContextValue {
  const value = useContext(ApiDocsPageContext);
  if (!value) {
    throw new Error("useApiDocsPageContext requires ApiDocsPageProvider");
  }
  return value;
}

/** @deprecated use useApiDocsPageContext */
export function useApiDocsFixtures(): ApiDocsFixtures {
  return useApiDocsPageContext().fixtures;
}
