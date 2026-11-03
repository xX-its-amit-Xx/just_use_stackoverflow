import { createServer } from './server.js';
const port = Number(process.env.PORT) || 3000;
createServer({ dataFile: process.env.DATA_FILE || './data.json' }).listen(port, () => console.log(`pm-s4 listening on ${port}`));
