import { evaluate } from './calc.js';
try {
  console.log(String(evaluate(process.argv[2] ?? '')));
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
