// Glue (project-written): provides the `decodeHTML` function that markdown-it
// expects from the `entities` npm package, backed by the vendored HTML5 named
// entity table in ./entities.json (keys are names without the trailing `;`).
// Numeric references are handled by markdown-it itself, so only named
// references are decoded here. Unknown names are returned unchanged.

import entityMap from './entities.json' with { type: 'json' }

const reNamed = /&([A-Za-z][A-Za-z0-9]*);/g

export function decodeHTML (str) {
  return str.replace(reNamed, (match, name) =>
    Object.prototype.hasOwnProperty.call(entityMap, name) ? entityMap[name] : match
  )
}

export default { decodeHTML }
