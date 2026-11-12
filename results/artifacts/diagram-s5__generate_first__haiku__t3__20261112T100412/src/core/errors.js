export class DiagramError extends Error {
  constructor(message, code = 'DIAGRAM_ERROR') {
    super(message);
    this.name = 'DiagramError';
    this.code = code;
  }
}
