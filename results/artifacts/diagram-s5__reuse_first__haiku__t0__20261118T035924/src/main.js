// Starts the collaboration server: DATA_DIR (default ./data) and PORT (default 3000).
import path from 'node:path';
import { createServer } from './server.js';

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const port = Number(process.env.PORT ?? 3000);
createServer({ dataDir }).listen(port, () => {
  console.log(`diagram-s5 listening on http://localhost:${port}`);
});
