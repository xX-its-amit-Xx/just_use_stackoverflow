import { createServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || './data';
createServer({ dataDir }).listen(port, () => {
  console.log(`markdown wiki listening on http://localhost:${port} (data: ${dataDir})`);
});
