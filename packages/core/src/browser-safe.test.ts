import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The root entry of @standin/core must stay importable from browser bundles
 * (alexa-sim, call-card UI): no node:* built-ins and no native modules in its
 * transitive import graph. Node-only code goes behind '@standin/core/sqlite'.
 */
function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || graph.has(file)) continue;
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
    graph.set(file, specs);
    for (const s of specs) if (s.startsWith('./')) queue.push(s.slice(2).replace(/\.js$/, '.ts'));
  }
  return graph;
}

describe('@standin/core root entry is browser-safe', () => {
  it('imports no node built-ins or native modules', () => {
    const graph = importGraph('index.ts');
    expect(graph.has('event-log.ts')).toBe(true);
    for (const [file, specs] of graph) {
      for (const s of specs) {
        expect(s.startsWith('./') || s === 'zod', `${file} imports ${s}`).toBe(true);
      }
    }
    expect(graph.has('sqlite-repo.ts')).toBe(false);
  });
});
