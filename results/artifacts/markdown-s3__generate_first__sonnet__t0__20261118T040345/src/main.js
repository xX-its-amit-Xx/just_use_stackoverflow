import { createServer } from './server.js';
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || './data';
createServer({ dataDir }).listen(port, () => console.log(`markdown-s3 listening on http://localhost:${port}`));
