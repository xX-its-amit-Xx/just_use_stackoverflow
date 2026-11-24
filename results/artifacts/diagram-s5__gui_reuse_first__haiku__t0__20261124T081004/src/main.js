import path from 'node:path';
import { createServer } from './server.js';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const server = createServer({ dataDir });
server.listen(port, () => {
  console.log(`diagram-s5 listening on http://localhost:${port} (data: ${dataDir})`);
});
