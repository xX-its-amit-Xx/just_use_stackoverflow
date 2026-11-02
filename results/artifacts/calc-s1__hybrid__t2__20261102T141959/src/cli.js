import { evaluate, CalcError } from './calc.js';
try { console.log(String(evaluate(process.argv[2]))); }
catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
