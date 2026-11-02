import { createServer } from './server.js';
const port = process.env.PORT || 3000;
createServer({ dataFile: process.env.DATA_FILE || './data.json' }).listen(port, () => console.log('listening on ' + port));
