/**
 * Point 7, the main-process half: given any new knowledge base,
 * repository, or folder -- or an update to one already registered --
 * walk it, ingest every eligible file into the existing Enterprise
 * Knowledge Graph (knowledge.ts), and regenerate the condensed map
 * every agent is told to read by default (see hive.ts's
 * injectedPrompt). An agent that wants more than the summary already
 * has the existing `kg get <id>` / `kg search` path (knowledge.ts's
 * env()) -- this module only adds the "ingest a whole folder, and
 * keep it current automatically" half that was missing.
 *
 * No per-file LLM call for a summary (see knowledgeMap.ts's
 * deriveFallbackSummary docstring on why) -- this stays fast, free,
 * and reproducible, at the cost of a shallower summary than a model
 * would write. A human can still hand-write a better caption for any
 * one document through the existing KG UI; folder-ingested files just
 * don't get one automatically.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { KnowledgeManager } from './knowledge';
import { deriveFallbackSummary, formatCondensedMap } from '../shared/knowledgeMap';

const ALLOWED_EXT = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt',
  '.json', '.yaml', '.yml', '.toml', '.sql', '.html', '.css'
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv']);
const MAX_FILES_PER_FOLDER = 500;
const MAX_FILE_BYTES = 200_000;
const WATCH_DEBOUNCE_MS = 2000;

interface FileRecord {
  hash: string;
  docId: string;
}
type FolderRegistry = Record<string, Record<string, FileRecord>>; // folderPath -> filePath -> record

function walk(root: string, out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_FOLDER) break;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (ALLOWED_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

export class KnowledgeFolderIngestor {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(private km: KnowledgeManager, private hiveRoot: () => string | null) {}

  private registryPath(): string | null {
    const root = this.hiveRoot();
    return root ? join(root, 'knowledge-folders.json') : null;
  }

  private mapPath(): string | null {
    const root = this.hiveRoot();
    return root ? join(root, 'knowledge-map.md') : null;
  }

  private readRegistry(): FolderRegistry {
    const p = this.registryPath();
    if (!p || !existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }

  private writeRegistry(reg: FolderRegistry): void {
    const p = this.registryPath();
    if (!p) return;
    writeFileSync(p, JSON.stringify(reg, null, 2), 'utf8');
  }

  /** Every registered folder, for restoring watchers across an app
   *  restart (watchAll, below) and for the UI to list what's tracked. */
  registeredFolders(): string[] {
    return Object.keys(this.readRegistry());
  }

  /** Ingests every eligible file under `folder` that's new or changed
   *  since the last scan (content-hash compared, so an unchanged file
   *  costs nothing), then regenerates knowledge-map.md. Idempotent --
   *  safe to call repeatedly, including from the debounced watcher. */
  ingestFolder(folder: string): { added: number; updated: number; unchanged: number; removed: number } {
    const result = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    if (!this.km.active() || !existsSync(folder)) return result;

    const registry = this.readRegistry();
    const known = registry[folder] ?? {};
    const next: Record<string, FileRecord> = {};
    const seen = new Set<string>();

    for (const file of walk(folder)) {
      seen.add(file);
      let text: string;
      try {
        const stat = statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const hash = createHash('sha256').update(text).digest('hex');
      const existing = known[file];
      if (existing?.hash === hash) {
        next[file] = existing;
        result.unchanged++;
        continue;
      }
      // A changed file's old docId is removed first -- kg-core.cjs's
      // ingest() always appends a fresh search-index entry, so
      // re-ingesting the same path without removing the old one first
      // would leave duplicate, stale entries in index.jsonl.
      if (existing?.docId) this.km.remove(existing.docId);
      const title = relative(folder, file);
      const summary = deriveFallbackSummary(text, title);
      const ingested = this.km.ingestText(text, { title, caption: summary } as { title: string; caption: string; tags?: string[] });
      next[file] = { hash, docId: ingested.docId };
      if (existing) result.updated++;
      else result.added++;
    }

    // A file that was known but no longer exists on disk (deleted,
    // renamed, moved out of the allow-list) is removed from the KG
    // too -- the condensed map must never name a document an agent
    // can't actually open.
    for (const [file, record] of Object.entries(known)) {
      if (!seen.has(file)) {
        this.km.remove(record.docId);
        result.removed++;
      }
    }

    registry[folder] = next;
    this.writeRegistry(registry);
    this.regenerateMap();
    return result;
  }

  /** Writes knowledge-map.md from the KG's current full list --
   *  always called after ingestFolder, and safe to call on its own
   *  (e.g. after a manual KG edit through the existing UI) to pick up
   *  anything not added through folder ingestion at all. */
  regenerateMap(): void {
    const path = this.mapPath();
    if (!path) return;
    const docs = this.km.list();
    const entries = docs.map((d) => ({ id: d.id, title: d.title, summary: d.caption?.trim() || '(no summary available)' }));
    writeFileSync(path, formatCondensedMap(entries, join(this.km.root(), 'docs')), 'utf8');
  }

  /** Registers `folder` (persists it, does an immediate ingest pass,
   *  starts watching it) -- "any new knowledge base / repository /
   *  folder" becoming part of the knowledge base, as discussed. */
  registerFolder(folder: string): void {
    this.ingestFolder(folder);
    this.watch(folder);
  }

  unregisterFolder(folder: string): void {
    this.watchers.get(folder)?.close();
    this.watchers.delete(folder);
    const registry = this.readRegistry();
    for (const record of Object.values(registry[folder] ?? {})) this.km.remove(record.docId);
    delete registry[folder];
    this.writeRegistry(registry);
    this.regenerateMap();
  }

  /** "...or an update to these knowledge bases/repositories/folders"
   *  -- fs.watch (recursive where the platform supports it; macOS and
   *  Windows do) fires on any change under the folder; debounced so
   *  a burst of saves (a git checkout, a build) triggers one rescan,
   *  not dozens. Best-effort: a watch failure never breaks the app,
   *  it just means that folder stops auto-updating until re-registered. */
  private watch(folder: string): void {
    this.watchers.get(folder)?.close();
    try {
      const watcher = watch(folder, { recursive: true }, () => {
        const existingTimer = this.debounceTimers.get(folder);
        if (existingTimer) clearTimeout(existingTimer);
        this.debounceTimers.set(
          folder,
          setTimeout(() => {
            this.debounceTimers.delete(folder);
            this.ingestFolder(folder);
          }, WATCH_DEBOUNCE_MS)
        );
      });
      this.watchers.set(folder, watcher);
    } catch {
      // Best-effort: some platforms/filesystems refuse recursive
      // watch. The folder stays ingested as of the last scan; it just
      // won't auto-update until registerFolder() is called again.
    }
  }

  /** Called once at app start to resume watching every previously
   *  registered folder (watchers don't survive a process restart). */
  watchAll(): void {
    for (const folder of this.registeredFolders()) this.watch(folder);
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}
