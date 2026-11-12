// Entry point: node src/main.js  (env: PORT, DATA_FILE)
import path from 'node:path';
import { createServer } from './server.js';

const port = Number(process.env.PORT || 3000);
const dataFile = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'pm.json');

const server = createServer({ dataFile });
server.listen(port, () => {
  console.log(`pm-s4 listening on http://localhost:${port} (data: ${dataFile})`);
});
