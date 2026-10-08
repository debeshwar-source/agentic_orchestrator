/**
 * Point 7, as discussed: given any new knowledge base / repository /
 * folder, or an update to one, every agent gets a condensed map of it
 * by default -- bounded regardless of how large the corpus grows --
 * and is free to fetch the full document if it decides it needs to.
 *
 * Pure formatting/derivation only -- no fs, no electron. The actual
 * folder-walking and file-watching live in src/main/knowledgeFolders.ts,
 * which calls this to turn KnowledgeManager.list()'s output into the
 * text written to <hive root>/knowledge-map.md.
 */

export interface KnowledgeMapEntry {
  id: string;
  title: string;
  summary: string;
}

export const MAX_ENTRIES_SHOWN = 60;

/** Every ingested doc gets a caption from whoever added it (a human,
 *  via the KG UI) OR, for a folder-ingested file, no caption at all --
 *  kg-core.cjs's own ingest() leaves `caption: null` when none is
 *  given. Rather than an LLM call per file (real cost, and a live
 *  network/model dependency inside a plain folder scan), this derives
 *  a short, deterministic stand-in: the first non-trivial line of the
 *  text, trimmed. Cheap, reproducible, and good enough for "what is
 *  this file" at a glance -- a human or an agent can still open the
 *  full document for the real thing. */
export function deriveFallbackSummary(text: string, title: string): string {
  const normalizedTitle = title.trim().toLowerCase();
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^#+\s*/, ''))
    .find((l) => l.length > 8 && l.toLowerCase() !== normalizedTitle);
  const base = line ?? title;
  return base.length > 160 ? base.slice(0, 159).trimEnd() + '…' : base;
}

/** Bounded regardless of corpus size: the 61st document doesn't make
 *  this block any bigger, it just means the overflow count grows
 *  instead -- same principle as the repo map's own size cap, applied
 *  to a general document corpus instead of source code. */
export function formatCondensedMap(entries: KnowledgeMapEntry[], docsDir: string): string {
  if (entries.length === 0) {
    return '# Knowledge base\n\n(empty -- no documents ingested yet.)\n';
  }
  const shown = entries.slice(0, MAX_ENTRIES_SHOWN);
  const lines = shown.map((e) => `- **${e.title}** (\`${e.id}\`): ${e.summary}`);
  const overflow = entries.length - shown.length;
  const header = [
    '# Knowledge base — condensed map',
    '',
    `${entries.length} document(s). This is a SUMMARY ONLY — for the full text of any entry, run`,
    '`kg get <id>` (see your system prompt for the exact command) or read it directly at',
    `\`${docsDir}/<id>/text.md\`. Do not assume the summary below is complete; open the`,
    'document if the task actually depends on its detail.',
    ''
  ].join('\n');
  const body = lines.join('\n');
  const footer = overflow > 0 ? `\n\n… and ${overflow} more document(s) not shown here — search the knowledge base (\`kg search "<query>"\`) rather than assuming this list is exhaustive.` : '';
  return header + body + footer + '\n';
}
