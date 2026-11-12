import { createArchWeave } from './app.ts';
import { configFromEnv } from './config.ts';

const config = configFromEnv();
const archweave = await createArchWeave(config);
const running = await archweave.listen();

console.log(`ArchWeave is modeling ${config.repoDir}`);
console.log(`  data: ${config.dataDir}`);
console.log(`  ui:   ${running.url}`);
console.log(`  mcp:  ${running.url}/mcp`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await running.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
