import { createServer } from './server.js';
const srv = createServer({ dataFile: process.env.DATA_FILE || 'data.json' });
const port = Number(process.env.PORT) || 3000;
srv.listen(port, () => console.log(`pm-s4 listening on ${port}`));
