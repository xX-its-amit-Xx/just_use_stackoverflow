import { createServer } from './server.js';

const port = Number(process.env.PORT || 3000);
const dataFile = process.env.DATA_FILE || 'data/pm.json';
createServer({ dataFile }).listen(port, () => {
  console.log(`pm-s4 listening on http://localhost:${port} (data: ${dataFile})`);
});
