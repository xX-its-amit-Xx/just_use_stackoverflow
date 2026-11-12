import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data');

const server = createServer({ dataDir });
server.listen(port, () => {
  process.stdout.write(`diagram-s5 listening on http://localhost:${port} (data: ${dataDir})\n`);
});
