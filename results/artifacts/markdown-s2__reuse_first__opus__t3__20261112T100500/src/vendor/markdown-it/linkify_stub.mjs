// Minimal stand-in for linkify-it (linkify is disabled in this project).
export default function LinkifyIt () {
  if (!(this instanceof LinkifyIt)) return new LinkifyIt()
}
LinkifyIt.prototype.test = function () { return false }
LinkifyIt.prototype.pretest = function () { return false }
LinkifyIt.prototype.match = function () { return null }
LinkifyIt.prototype.matchAtStart = function () { return null }
LinkifyIt.prototype.set = function () { return this }
LinkifyIt.prototype.add = function () { return this }
LinkifyIt.prototype.tlds = function () { return this }
