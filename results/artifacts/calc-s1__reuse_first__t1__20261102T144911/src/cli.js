import { evaluate, CalcError } from './calc.js';
try {
  console.log(String(evaluate(process.argv[2] ?? '')));
} catch (e) {
  console.error(`Error: ${e instanceof CalcError ? e.message : String(e)}`);
  process.exit(1);
}
