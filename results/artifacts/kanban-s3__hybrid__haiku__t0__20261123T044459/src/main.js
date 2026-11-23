import { createServer } from './server.js';

const port = process.env.PORT || 3000;
const dataFile = process.env.DATA_FILE || './data.json';

createServer({ dataFile }).listen(port, () => {
  console.log(`kanban-s3 listening on http://localhost:${port} (data: ${dataFile})`);
});
