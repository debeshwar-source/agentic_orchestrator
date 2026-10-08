/**
 * Point 8, as discussed: given any new task, a condensed summary of
 * what's been implemented/decided so far is available to every agent
 * by default, and any agent is free to delve into the full detail
 * (the task card's own `result`/`description` in tasks.json) if it
 * wishes.
 *
 * Pure formatting only -- no fs, no electron. Populated as a
 * guaranteed side effect of HiveManager.signOffTask() approving a
 * step (never something an agent or the orchestrator has to remember
 * to maintain, same discipline as the task-card guarantee), written
 * to <hive root>/implementation-summary.md.
 */

export interface ImplementationEntry {
  stepId: string;
  stepName: string;
  summary: string;
  approvedAt: string;
}

export const MAX_ENTRIES_SHOWN = 40;

/** Bounded the same way the knowledge map is: a long-running task with
 *  many completed steps doesn't grow this file without limit -- the
 *  oldest entries drop off the SHOWN list (full history stays in
 *  tasks.json regardless, never lost, just not repeated here). */
export function formatImplementationSummary(entries: ImplementationEntry[], tasksPath: string): string {
  if (entries.length === 0) {
    return '# Implementation summary\n\n(nothing completed yet on this task.)\n';
  }
  const recent = entries.slice(-MAX_ENTRIES_SHOWN);
  const lines = recent.map((e) => `- **${e.stepName}**: ${e.summary}`);
  const overflow = entries.length - recent.length;
  const header = [
    '# Implementation summary — what has been decided so far',
    '',
    'This is a SUMMARY of each completed step\'s outcome, not the full reasoning behind it.',
    `For the full result of any step, read its card in \`${tasksPath}\` (match by step name).`,
    ''
  ].join('\n');
  const body = lines.join('\n');
  const footer = overflow > 0 ? `\n\n(${overflow} earlier step(s) also completed — see ${tasksPath} for the full history.)` : '';
  return header + body + footer + '\n';
}
