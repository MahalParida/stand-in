import { readdir } from 'node:fs/promises';

/** Lists golden scenario files (data/scenarios/*.json). Scenario schema arrives in M2. */
export async function listScenarioFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
}
