import path from 'node:path';
import { createServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const server = createServer({ dataDir });
server.listen(port, () => {
  console.log(`markdown wiki listening on http://localhost:${port} (data: ${dataDir})`);
});
