// Error type for calculator failures. `position` is the 0-based index into the input.
export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}
