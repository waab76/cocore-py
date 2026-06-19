import type { LexiconDocsPageData } from "@/lib/lexicon-docs/types.ts";

import { parseLexiconDocument, sortLexiconDocsEntries } from "@/lib/lexicon-docs/parse.ts";
import { isLexiconDocsListedEntry } from "@/lib/lexicon-docs/types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEXICON_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../lexicons/dev/cocore",
);

let cachedPageData: LexiconDocsPageData | null = null;

function listLexiconJsonFiles(dir: string): Array<string> {
  const out: Array<string> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listLexiconJsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(fullPath);
    }
  }
  return out;
}

export function loadLexiconDocsPageData(): LexiconDocsPageData {
  if (cachedPageData) {
    return cachedPageData;
  }

  const files = listLexiconJsonFiles(LEXICON_DIR).toSorted();

  const entries = files
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return parseLexiconDocument(raw);
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .filter((entry) => isLexiconDocsListedEntry(entry));

  cachedPageData = { entries: sortLexiconDocsEntries(entries) };
  return cachedPageData;
}
