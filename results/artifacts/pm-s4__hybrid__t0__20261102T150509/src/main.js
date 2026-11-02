import { createServer } from './server.js';
const srv = createServer({ dataFile: process.env.DATA_FILE || 'data.json' });
srv.listen(Number(process.env.PORT) || 3000, () => console.log('pm-s4 listening'));
