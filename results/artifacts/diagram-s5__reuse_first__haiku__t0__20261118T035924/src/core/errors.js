// Error type used for every invalid operation, unknown id or locked-layer violation.
export class DiagramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagramError';
  }
}
