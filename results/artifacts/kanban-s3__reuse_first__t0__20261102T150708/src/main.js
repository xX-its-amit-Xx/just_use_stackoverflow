import { createServer } from './server.js';
createServer({ dataFile: process.env.DATA_FILE || './data.json' }).listen(process.env.PORT || 3000);
