/**
 * A published workflow's jobs and the secrets each reads, as text — the readers the build-workflow
 * censuses share, so a second spelling of "which lines are one job" cannot drift from the first.
 */

/** Every secret a job's steps read, in any expression — a secret named in a comment is not read. */
export function secretsRead(job: string): string[] {
  const exec = job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return [...new Set([...exec.matchAll(/\$\{\{[^}]*?\bsecrets\.([A-Z0-9_]+)[^}]*\}\}/g)].map((m) => m[1]))].sort();
}

/** One job's text, from its key to the next job key at the same indent. */
export function jobText(text: string, job: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z][\w-]*:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
