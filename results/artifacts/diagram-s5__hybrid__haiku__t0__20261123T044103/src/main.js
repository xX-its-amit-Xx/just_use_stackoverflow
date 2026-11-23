import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data');
const port = Number(process.env.PORT ?? 3000);
const server = createServer({ dataDir });
server.listen(port, () => {
  console.log(`diagram-s5 listening on http://localhost:${port}`);
});
