import { createServer } from './server.js';
const port = Number(process.env.PORT) || 3000;
createServer({ dataDir: process.env.DATA_DIR || './data' }).listen(port, () => console.log(`listening on ${port}`));
