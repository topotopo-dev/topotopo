// Identities shared by benchmark runs and reports. Labels are presentation, never comparison boundaries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function stableJSON(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const hash = (value: unknown) => crypto.createHash('sha256').update(stableJSON(value)).digest('hex').slice(0, 16);

/** JSON is hashed by value, paths with '/', binary inputs as bytes: checkout line endings and OS do not matter. */
export function hashSuite(dir: string): string {
  const entries: [string, string][] = [];
  const walk = (d: string, parts: string[]) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = path.join(d, e.name), names = [...parts, e.name];
      if (e.isDirectory()) walk(p, names);
      else {
        const bytes = fs.readFileSync(p);
        entries.push([names.join('/'), e.name.endsWith('.json') ? stableJSON(JSON.parse(bytes.toString('utf8'))) : bytes.toString('base64')]);
      }
    }
  };
  walk(dir, []);
  return hash(entries);
}

export interface ComparisonResult {
  topotopo: { version: string; commit: string | null };
  suite: string;
  settings: { effort: string; images: boolean; limits: { toolCalls: number; minutes: number }; endpoint?: string };
  provider: string;
  model: string;
  date?: string;
}

/** Different revisions, suites or budgets never share a leaderboard, even within the same released version. */
export function comparisonKey(r: ComparisonResult): string {
  return `${r.topotopo.version}-${hash({
    commit: r.topotopo.commit ?? `unknown:${r.date ?? ''}:${r.provider}:${r.model}`,
    suite: r.suite,
    effort: r.settings.effort,
    images: r.settings.images,
    limits: r.settings.limits,
  })}`;
}

/** Two providers/models with the same display label remain separate rows and files. */
export const participantKey = (r: Pick<ComparisonResult, 'provider' | 'model' | 'settings'>) =>
  hash({ provider: r.provider, model: r.model, endpoint: r.settings.endpoint ?? 'default' });
