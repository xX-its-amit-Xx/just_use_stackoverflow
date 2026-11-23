import { createServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const dataFile = process.env.DATA_FILE || 'data/pm-data.json';
const server = createServer({ dataFile });
server.listen(port, () => console.log(`pm-s4 listening on http://localhost:${port}`));
