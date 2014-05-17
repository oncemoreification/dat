// this module assumes it will be used as a .prototype (e.g. uses `this`)

var fs = require('fs')
var path = require('path')
var http = require('http')
var EOL = require('os').EOL
var events = require('events')

var bops = require('bops')

var rimraf = require('rimraf')
var mkdirp = require('mkdirp')
var extend = require('extend')
var request = require('request')
var corsify = require('corsify')
var levelup = require('levelup')
var ansimd = require('ansimd')
var sleepRef = require('sleep-ref')
var liveStream = require('level-live-stream')
var ldj = require('ldjson-stream')
var jsonBuffStream = require('json-multibuffer-stream')
var multibuffer = require('multibuffer')
var csvWriter = require('csv-write-stream')
var connections = require('connections')
var through = require('through2')
var version = require("level-version")
var clearLog = require('single-line-log')
var multilevel = require('multilevel/msgpack')
var stdout = require('stdout-stream')
var debug = require('debug')('dat.commands')

var clone = require(path.join(__dirname, 'clone'))
var storage = require(path.join(__dirname, 'storage'))
var replicator = require(path.join(__dirname, 'replicator'))
var blobs = require(path.join(__dirname, 'blobs'))
var restHandler = require(path.join(__dirname, 'rest-handler'))
var writeStream = require(path.join(__dirname, 'write-stream'))
var getPort = require(path.join(__dirname, 'get-port'))

var dat = {}

function noop(){}

module.exports = dat

dat.dbOptions = {
  writeBufferSize: 1024 * 1024 * 16 // 16MB
}

dat.defaultPort = 6461

dat.paths = function(root) {
  root = root || this.dir || process.cwd()
  var datPath = path.join(root, '.dat')
  var levelPath = path.join(datPath, 'store.dat')
  var jsonPath = path.join(datPath, 'schema.json')
  var portPath = path.join(datPath, 'PORT')
  var blobsPath = path.join(datPath, 'objects')

  return {
    dat: datPath,
    level: levelPath,
    json: jsonPath,
    port: portPath,
    blobs: blobsPath
  }
}

dat.exists = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  if (typeof options === 'string') options = {path: options}
  if (!options) options = {}
  var paths = this.paths(options.path)
  fs.exists(paths.dat, function datExists(exists) {
    if (!exists) return cb(exists)
    fs.exists(paths.level, function levelExists(exists) {
      if (!exists) return cb(exists)
      fs.exists(paths.json, function jsonExists(exists) {
        cb(exists)
      })
    })
  })
}

dat.init = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  if (typeof options === 'string') options = {path: path}
  
  var self = this
  var paths = this.paths(options.path)
  
  this._mkdir(options, function(err, exists) {
    if (err) return cb(err)
    if (exists) return cb(new Error("A dat store already exists here"))
    initStorage(options, cb)
  })
  
  function initStorage(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = options
    }
    self._storage(opts, function(err) {
      if (err) return cb(err)
      cb(err, "Initialized dat store at " + paths.dat)
    })
  }
}

dat._mkdir = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  
  var self = this
  var paths = this.paths(options.path)
  mkdirp(paths.dat, function (err) {
    if (err) return cb(err)
    self.meta.write(self.meta.json, function(err) {
      if (err) return self.meta.write(options, checkExists)
      checkExists()
    })
  })
  
  function checkExists() {
    self.exists(options.path, function datExists(exists) {
      cb(null, exists)
    })
  }
  
}

dat.destroy = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  var self = this
  if (typeof options === 'string') options = {path: path}
  
  var paths = self.paths(options.path)
  
  this.close(function(err) {
    if (err) return cb(err)
    destroyDB()
  })
  
  function destroyDB() {
    rimraf(paths.dat, cb)
  }
}

dat.help = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  var help = fs.readFileSync(path.join(__dirname, '..', 'docs', 'usage.md'))
  
  console.log(ansimd(help))
  
  setImmediate(cb)
}

dat.getRowCount = function() {
  return this.meta.rowCount
}

dat.serve = function(options, cb) {
  if (!cb) {
    cb = options
    options = {}
  }
  var self = this
  
  // if already listening then return early w/ success callback
  if (this._server && this._server.address()) {
    setImmediate(function() {
      cb(null, 'Listening on http://localhost:' + self._server.address().port)
    })
    return
  }
  
  this._ensureExists(options, function exists(err) {
    if (err) return cb(false, err)
    var restAPI = restHandler(self)
    self.cors = corsify({
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE"
      // todo add whitelist to options
    })
    self._server = http.createServer(self.cors(handle))
    function handle(req, res) {
      return restAPI.handle(req, res)
    }
    // TODO set socket timeout
    self.connections = connections(self._server)
    var startingPort = options.port || self.defaultPort
    getPort(startingPort, self.paths().port, function(err, port) {
      if (err) return cb(err)
      self._server.listen(port, function(err) {
        cb(err, 'Listening on ' + port)
      })
    })
  })
}

dat.push = function(options, cb) {
  var self = this
  if (typeof options === 'string') options = {'0': options}
  var remote = options['0']
  if (!remote) return cb(new Error('no remote specified'))
  remote = self.normalizeURL(remote)
  
  var pushStream = self.replicator.createPushStream(remote, options)
  
  if (options.verbose) {
    pushStream.pipe(self.resultPrinter())
  } else if (!options.quiet) {
    pushStream.pipe(ldj.parse()).pipe(self.progressLogStream('pushed'))
  }
  
  pushStream.on('end', cb)
  pushStream.on('error', cb)
}

dat.pull = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  if (typeof options === 'string') {
    options = [options]
  }
  if (!cb) cb = function(){}
  var self = this
  this._ensureExists(options, function exists(err) {
    if (err) return cb(false, err)
    self._storage(options, function(err, store) {
      if (err) return cb(err, err.message)
      pull()
    })
  })
  
  var remote = options['0'] || 'http://127.0.0.1:' + this.defaultPort
  remote = this.normalizeURL(remote)
  
  var pullObj = {
    end: function() {
      if (self.pulling[remote].end) self.pulling[remote].end()
    }
  }
  
  return pullObj
  
  function pull() {
    if (!self.pulling) self.pulling = {}
    if (self.pulling[remote]) return cb(new Error('Already pulling from that remote'))
    self.pulling[remote] = true
    
    createPullWriteStream()
    
    function createPullWriteStream() {
      self.meta.pullSchema(remote, function(err) {
        if (err) {
          delete self.pulling[remote]
          return cb(err, "Could not get remote schema")
        }
        
        debug('pull', remote)
        
        var pullStream = self.replicator.createPullStream(remote)
        
        self.pulling[remote] = pullStream
        
        if (!options.quiet) pullStream.pipe(self.progressLogStream('pulled'))
        
        pullStream.on('end', function() {
          if (options.live) return setTimeout(pull, 5000)
          delete self.pulling[remote]
          if (!options.quiet) clearLog('Pulling from changes has completed.\n')
          cb()
        })
        
        pullStream.on('error', function(err) {
          // TODO better error handling
          console.log('pull err', err)
        })
      })
    }
  }
}

dat.clone = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  
  var self = this
  
  // TODO make clone actually respect path
  var paths = this.paths(options.path)
  
  var remote
  if (typeof options === 'string') remote = options
  else remote = options.remote || options[0]
  var remoteErr = new Error('Must specify remote!')
  if (!remote) cb(remoteErr, remoteErr.message)
  
  remote = this.normalizeURL(remote)
  
  if (typeof opts === 'function') {
    cb = opts
    opts = options
  }
  
  this._mkdir(options, function(err, exists) {
    if (err) return cb(err, err.message)
    
    // TODO add --force option to overwrite
    if (exists) return cb(new Error("Cannot clone into existing dat repo"))
    
    clone(self, remote, function(err) {
      if (err) return cb(err, err.message)
      self._storage(options, function(err) {
        if (err) return cb(err, err.message)
        cb(err, "Loaded dat store at " + paths.dat)
      })
    })
    
  })
}

dat.cat = function(options, cb) {
  if (!options) options = {}
  if (!cb) cb = noop
  if (!options.f && !options.json) options.json = true
  var readStream = this.createReadStream(options)
  readStream.pipe(stdout)
  readStream.on('end', cb)
  readStream.on('error', cb)
}

dat.dump = function(options, cb) {
  if (!options) options = {}
  if (!cb) cb = noop
  var lev = this._level(options.path)
  var logger = ldj.serialize()
  lev.createReadStream().pipe(logger).pipe(stdout)
  logger.on('end', cb)
}

dat.headers = function(options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }

  var cols = this.schema.toJSON().map(function(col) {
    return col.name
  });

  var headers = ['id', 'version'].concat(cols)
  if (!cb) return headers
  cb(null, headers)
}

dat.get = function(key, opts, cb) {
  return this.storage.get(key, opts, cb)
}

dat.put = function(rawDoc, buffer, opts, cb) {
  return this.storage.put(rawDoc, buffer, opts, cb)
}

dat.delete = function(key, opts, cb) {
  return this.storage.delete(key, opts, cb)
}

dat.createReadStream = function(opts) {
  var self = this
  if (!opts) opts = {}
  var readStream = this.storage.createReadStream(opts)
  
  if (opts.csv || opts.f === 'csv') var formatter = csvWriteStream()
  else if (opts.buff || opts.f === 'buff') var formatter = buffStream()
  else if (opts.json || opts.f === 'json') var formatter = ldj.serialize()
  
  // default to objects
  if (!formatter) return readStream
  
  readStream.pipe(formatter)
  return formatter
  
  function csvWriteStream() {
    var headers = self.headers()
    return csvWriter({headers: headers})
  }
  
  function buffStream() {
    var headers = self.headers()
    var encoder = jsonBuffStream(headers)
    var obj = {}
    headers.map(function(h) { obj[h] = h })
    encoder.write(obj)
    return encoder
  }
}

dat.createChangesStream = function(opts) {
  return this.storage.createChangesStream(opts)
}

// todos:
// check for existing attachment by filename
// check for doc conflicts before writing blob to disk
// store filename, content-length, version?
// emit progress events
// resumable blob writes
dat.createBlobWriteStream = function(options, doc, cb) {
  var self = this
  
  if (typeof doc === 'function') {
    cb = doc
    doc = undefined
  }
  
  if (typeof doc === 'string') {
    doc = { id: doc }
  }
  
  if (typeof options === 'string') {
    options = { filename: options }
  }
  
  if (!doc) doc = {}
  if (!cb) cb = noop
  
  debug('createBlobWriteStream', options.filename)
  
  var blobWrite = this.blobs.createWriteStream(options, function(err, hash) {
    if (err) return cb(err)
    if (!doc.attachments) doc.attachments = {}
    doc.attachments[options.filename] = {
      hash: hash
    }
    self.put(doc, function(err, stored) {
      cb(err, stored)
    })
  })
  
  return blobWrite
}

dat.createWriteStream = function(options, cb) {
  return writeStream(this, options, cb)
}

dat.createVersionStream = function(id, options) {
  return this.storage.createVersionStream(id, options)
}

dat.close = function(cb) {
  var self = this
  if (!cb) cb = noop
  
  if (this.rpcRequest) this.rpcRequest.end()
  
  if (this.db) {
    this.db.close(function(err) {
      if (err) return cb(err)
      closeServer()
    })
  } else {
    closeServer()
  }
  
  function closeServer() {
    if (self._server) {
      self.connections.destroy()
      try {
        self._server.close(rmPort)
      } catch(e) {
        rmPort()
      }
    } else {
      setImmediate(cb)
    }
  }
  
  function rmPort() {
    fs.unlink(self.paths().port, function(err) {
      // ignore err
      cb()
    })
  }
}

dat._level = function(dbPath, opts, cb) {
  var self = this
  if (this.db) return this.db
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  dbPath = dbPath || this.paths(dbPath).level
  this.dbOptions = extend({}, this.dbOptions, opts)
  
  if (opts.remoteAddress) {
    this.db = remoteDb(opts)
    this.db.rpcServer = opts.remoteAddress
  } else {
    this.db = localDb()
  }
  
  installAddons(this.db)
  
  return this.db
  
  function remoteDb(opts) {
    var mdm = multilevel.client(opts.manifest)
    var rpcStream = mdm.createRpcStream()
    
    // TODO auto-reconnect
    self.rpcRequest = request.post(opts.remoteAddress + '/api/rpc')
    
    self.rpcRequest.on('error', function(err) {
      debug('RPC request error', err.message)
    })
    
    rpcStream.pipe(self.rpcRequest).pipe(rpcStream)
    
    setImmediate(cb)
    
    return mdm
  }
  
  function localDb() {
    var backend = self.meta.json.backend
    if (backend && backend !== "leveldown-prebuilt") {
      self.dbOptions.db = require(path.resolve(self.paths().dat, 'node_modules', backend))
    } else {
      self.dbOptions.db = self.opts.backend || require('leveldown-prebuilt')
    }
    
    var db = levelup(dbPath, self.dbOptions, cb)
    
    return db
  }

  function installAddons(db) {
    // db addons
    liveStream.install(db)
  }
}

dat.backend = function(options, cb) {
  var self = this
  var setTo

  if (typeof options === 'string') setTo = options
  else setTo = options[0]
  
  if (setTo) return this._backend.set(setTo, function(err) {
    if (err) return cb(err, err)
    cb(null, "Switched backend to " + setTo)
  })

  this._backend.installed(function(err, installed) {
    if (err) return cb(err)
    var installed = Object.keys(installed)
    if (!installed) installed = ['leveldown-prebuilt']
    else installed.push('leveldown-prebuilt')
    var result = {
      available: installed
    }
    var current = self.meta.json.backend
    if (!current) result.current = 'leveldown-prebuilt'
    else result.current = current
    cb(err, result)
  })
}

// initialize all storage related instances
dat._storage = function(options, cb) {
  var self = this
  var paths = this.paths(options.path)
  
  if (this.storage) {
    setImmediate(function() {
      cb(null, self.storage)
    })
    return
  }
  
  // custom backends must implement the same api as lib/<backend>
  var blobBackend = blobs
  if (options.blobs) blobBackend = options.blobs
  this.blobs = blobBackend(paths.blobs, options.hasher)
  
  var replicatorBackend = replicator
  if (options.replicator) replicatorBackend = options.replicator
  this.replicator = replicator(this, options)
  
  var leveldb = this._level(options.path, options, function onReady(err) {
    if (err) return cb(err)
    self.storage = storage(leveldb, self.meta, function(err) {
      if (err) return cb(err)
      // init sleep handler
      self._sleep(options, function(err, sleep) {
        if (err) return cb(err)
        self.sleep = sleep
        self.schema = self.storage.schema
        cb(null, self.storage)
      })
    })
  })
}

dat._ensureExists = function(options, cb) {
  this.exists(options, function(exists) {
    if (!exists) return cb("Error: You are not in a dat folder.")
    cb()
  })
}

dat._sleep = function(options, cb) {
  var self = this
  this._storage(options, function(err, store) {
    if (err) return cb(err)
    var sleepOpts = { style: "newline" }
    cb(false, sleepRef(function(opts) {
      var changes = self.createChangesStream(opts)
      return changes
    }, sleepOpts))
  })
}

dat.config = function(options, cb) {
  var self = this
  this._ensureExists(options, function exists(err) {
    if (err) return cb(false, err)
    cb(undefined, self.meta.json)
  })
}

dat.normalizeURL = function(urlString) {
  // strip trailing /
  if (urlString[urlString.length - 1] === '/') urlString = urlString.slice(0, urlString.length - 1)
  
  if (!urlString.match(/^http:\/\//)) urlString = 'http://' + urlString
  
  return urlString
}

dat.supportsLiveBackup = function() {
  // only leveldown-hyper has .liveBackup
  var leveldown = this.db.db
  var isHyper = !!leveldown.liveBackup
  return isHyper
}

dat.resultPrinter = function () {
  var results = through.obj(onResultWrite)
  function onResultWrite (obj, enc, next) {
    if (obj.success) process.stdout.write(JSON.stringify(obj.row) + EOL)
    else process.stderr.write(JSON.stringify(obj) + EOL)
    next()
  }
  return results
}

dat.progressLogStream = function(verb) {
  verb = verb || 'transferred'
  var start = Date.now()
  var count = 0
  var elapsed = 0
  
  var logStream = through.obj(function(ch, enc, cb) {
    ++count
    var runtime = ~~Math.floor((Date.now() - start) / 1000)
    if (runtime > elapsed) {
      elapsed = runtime
      log(elapsed, count)
    } else if (elapsed === 0) {
      log(elapsed, count)
    }
    cb()
  })
  
  function log(runtime, transferred) {
    if (runtime === 0) return clearLog(transferred + ' row' + (transferred === 1 ? '' : 's') + ' ' + verb + '\n')
    clearLog(transferred + ' rows ' + verb + '. Elapsed: ' + runtime + 's. ' + Math.floor(transferred / runtime) + ' rows/second\n')    
  }
  
  return logStream
}
