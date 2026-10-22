import { listScenarioFiles } from './scenarios.js';

const scenariosDir = new URL('../../data/scenarios/', import.meta.url);
const files = await listScenarioFiles(scenariosDir);
console.log(`${files.length} scenarios`);
process.exitCode = 0;
