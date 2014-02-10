var crypto = require('crypto')

var uuid = function() {
  // return Math.random().toString()
  return crypto.randomBytes(6).toString('hex')
}

var collisions = 0

var obj = {}
for (var i = 0; i < 10000000; i++) {
  if ((i % 1000000) === 0) console.log(i)
  var u = uuid()
  if (obj[u]) {
    collisions++
    console.log('collision', u)
  }
  obj[u] = true
}

console.log(collisions)
