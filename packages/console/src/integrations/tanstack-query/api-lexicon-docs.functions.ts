import { createServerFn } from "@tanstack/react-start";
import { loadLexiconDocsPageData } from "@/server/lexicon-docs/load.server.ts";

export const getLexiconDocsPageData = createServerFn({ method: "GET" }).handler(async () =>
  loadLexiconDocsPageData(),
);
