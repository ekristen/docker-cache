var events      = require('events');
var util        = require('util');
var redis       = require('redis');
var async       = require('async');
var Docker      = require('dockerode');
var DockerEvent = require('docker-events');

var DockerCache = function DockerCache(opts) {
  if (!(this instanceof DockerCache)) return new DockerCache(opts);

  this.opts = opts;

  this.id = opts.id || "docker";
  this.prefix = opts.prefix || "docker";
  this.updateInterval = (opts.updateInterval || 120) * 1000;
  this.expireInterval = (opts.expireInterval || this.updateInterval);
  this.ttl = opts.ttl || ((this.updateInterval * 1.5) / 1000);

  this.clearInterval = this.updateInterval + (Math.floor((Math.random() * 120) + 1) * 1000);

  this.imageUpdateInterval = (opts.imageUpdateInterval || 1800) * 1000;
  this.imageTTL = this.imageUpdateInterval * 1.5;

  this.docker = new Docker(this.opts.docker);
  this.redis = redis.createClient(this.opts.redis.port, this.opts.redis.host)

  events.EventEmitter.call(this);
};

require('util').inherits(DockerCache, events.EventEmitter);

DockerCache.prototype.run = function() {
  var cache = this;

  var events = new DockerEvent({
    docker: cache.docker
  }).start();

  events.on('start', function(event) {
    cache.docker.getContainer(event.id).inspect(function (err, containerInfo) {
      containerInfo.Id = containerInfo.ID || containerInfo.Id;

      cache.addContainer(containerInfo, function(err) {
        if (err) {
          cache.emit('log', 'error', err);
          cache.emit('error', err);
        }
      });
    });
  });
  
  events.on('restart', function(event) {
    cache.docker.getContainer(event.id).inspect(function (err, containerInfo) {
      containerInfo.Id = containerInfo.ID || containerInfo.Id;

      cache.addContainer(containerInfo, function(err) {
        if (err) {
          cache.emit('log', 'error', err);
          cache.emit('error', err);
        }
      });
    });
  });

  events.on('die', function(event) {
    cache.docker.getContainer(event.id).inspect(function (err, containerInfo) {
      containerInfo.Id = containerInfo.ID || containerInfo.Id;

      cache.addContainer(containerInfo, function(err) {
        if (err) {
          cache.emit('log', 'error', err);
          cache.emit('error', err);
        }
      });
    });
  });

  events.on('destroy', function(event) {
    cache.docker.getContainer(event.id).inspect(function (err, containerInfo) {
      containerInfo.Id = containerInfo.ID || containerInfo.Id;

      cache.deleteContainer(containerInfo, function(err) {
        if (err) {
          cache.emit('log', 'error', err);
          cache.emit('error', err);
        }
      });
    });
  });

  // Update Immediatelly then Periodically Update
  cache.updateContainers();
  cache.updateImages();
  cache.clearExpiredContainers();
  
  setInterval(cache.updateContainers.bind(this), cache.updateInterval);
  setInterval(cache.updateImages.bind(this), cache.imageUpdateInterval);
  setInterval(cache.clearExpiredContainers.bind(this), cache.expireInterval);
  
  return this;
};

DockerCache.prototype.updateContainers = function() {
  var cache = this;

  cache.docker.listContainers(function(err, containers) {
    if (err) {
      cache.emit('log', 'error', err);
      cache.emit('error', err);
    }

    async.each(containers, function(container, cb) {
      cache.docker.getContainer(container.Id).inspect(function(err, containerInfo) {
        if (err) {
          cb(err);
        }

        containerInfo.Id = containerInfo.ID || containerInfo.Id;

        cache.setContainerInfo(containerInfo, function(err) {
          if (err) {
            cb(err);
          }
          
          cb();
        });
      });
    }, function(err) {
      if (err) {
        cache.emit('log', 'error', err);
        cache.emit('error', err);
      }

      cache.setContainerList(containers);
    });
  });
  
  cache.emit('log', 'debug', util.format('updateContainers - host: %s', cache.id));
};

DockerCache.prototype.setContainerList = function(containers) {
  var cache = this;

  async.series([
    function(cb) {
      var key = util.format("%s:hosts:%s:containers", cache.prefix, cache.id);
  
      var multi = cache.redis.multi();
  
      multi.del(key);

      for (var i=0; i<containers.length; i++) {
        multi.sadd(key, containers[i].Id);
      }

      multi.expire(key, cache.ttl);
      multi.exec(function(err, replies) {
        if (err) {
          cb(err);
        }
        
        cb();
      });
    },
    function(cb) {
      cache.refreshHostLastUpdate();
      
      var key = util.format("%s:hosts:%s", cache.prefix, cache.id);
      cache.redis.expire(key, cache.ttl);
      
      var key = util.format("%s:hosts", cache.prefix);
      cache.redis.sadd(key, cache.id);
      cache.redis.expire(key, cache.ttl);
      
      cb();
    }
  ], function(err, results) {
    if (err) {
      cache.emit('log', 'error', err);
      cache.emit('error', err);
    }
    
    cache.publishEvent("refresh_containers", cache.id);
  });

};


DockerCache.prototype.setContainerInfo = function(container, callback) {
  var cache = this;
  
  async.series([
    function(cb) {
      var key = util.format("%s:containers:%s", cache.prefix, container.Id);
      
      var multi = cache.redis.multi()
      multi.del(key)

      var map = cache.objectToStringMap(container);

      for (var k in map) {
        multi.hset(key, k, map[k]);
      }
  
      multi.hset(key, "host", cache.id);
  
      multi.expire(key, Number(cache.ttl));
  
      multi.exec(function(err, replies) {
        if (err) {
          cb(err);
        }
        cb();
      });
    },
    function(cb) {
      var key = util.format("%s:containers:%s:json", cache.prefix, container.Id);

      var json = JSON.stringify(container);
      
      var multi = cache.redis.multi();
      multi.del(key);
      multi.set(key, json);
      multi.expire(key, cache.ttl);
      multi.exec(function(err, replies) {
        if (err) {
          cb(err);
        }
        
        cb();
      })
    },
    function(cb) {
      var multi = cache.redis.multi();
      key = util.format("%s:containers", cache.prefix);
      multi.sadd(key, container.Id);
      
      key = util.format("%s:images", cache.prefix);
      multi.sadd(key, container.Image);
      multi.expire(key, cache.imageTTL);
      
      key = util.format("%s:images:%s:hosts", cache.prefix, container.Image)
      multi.sadd(key, cache.id);
      multi.expire(key, cache.imageTTL);
      
      key = util.format("%s:images:%s:containers", cache.prefix, container.Image)
      multi.sadd(key, container.Id);
      multi.expire(key, cache.imageTTL);
      
      multi.exec(function(err, replies) {
        if (err) {
          cb(err);
        }
        
        cb();
      });
    },
    function(cb) {
      var key = util.format("%s:images:%s", cache.prefix, container.Image);
      cache.redis.hincrby(key, "containers_running", 1);
      cb();
    }
  ], function(err) {
    if (err) {
      callback(err);
    }
    
    callback();
  });
};

DockerCache.prototype.addContainer = function(container, callback) {
  var cache = this;
  
  async.series([
    function(cb) {
      cache.setContainerInfo(container, function(err) {
        if (err) {
          cb(err);
        }

        cb();
      });
    },
    function(cb) {
      var key = util.format("%s:hosts:%s", cache.prefix, cache.id);
      cache.redis.hincrby(key, "containers_running", 1);
      cb();
    },
    function(cb) {
      cache.refreshHostLastUpdate();
      cb();
    }
  ], function(err) {
    if (err) {
      callback(err);
    }

    callback();

    cache.publishEvent("new_container", cache.id, container.Id);
    
    cache.emit('log', 'debug', util.format('addContainer - host: %s, container: %s', cache.id, container.Id));
  });

};

DockerCache.prototype.deleteContainer = function(container) {
  var cache = this;

  async.series([
    function(cb) {
      var key = util.format("%s:container:%s", cache.prefix, container.Id);
  
      var multi = cache.redis.multi();
      multi.del(key);

      key = util.format("%s:hosts:%s:containers", cache.prefix, cache.id);
      multi.srem(key, container.Id);
  
      key = util.format("%s:images:%s:hosts", cache.prefix, cache.id);
      multi.srem(key, cache.id);
  
      key = util.format("%s:images:%s:containers", cache.prefix, container.Image);
      multi.srem(key, container.Id);
  
      key = util.format("%s:hosts:%s", cache.prefix, cache.id);
      multi.hincrby(key, "containers_running", -1);
  
      multi.exec(function(err, replies) {
        if (err) {
          cb(err)
        }
        
        cb();
      })
    }
  ], function(err, results) {
    if (err) {
      console.log(cb);
    }
    
    cache.refreshHostLastUpdate();
    
    cache.publishEvent("delete_container", cache.id, container.Id);
    
    cache.emit('log', 'debug', util.format('deleteContainer - host: %s, container: %s', cache.id, container.Id));
  });
};


DockerCache.prototype.updateImages = function() {
  var cache = this;
  
  cache.docker.listImages(function(err, images) {
    if (err) {
      cache.emit('log', 'error', 'err');
      cache.emit('error', 'err');
      return;
    }

    async.each(images, function(image, cb) {
      var key = util.format("%s:images:%s", cache.prefix, image.Id);

      for (var k in image) {
        if (typeof image[k] == "object") {
          var value = JSON.stringify(image[k]);
        }
        else {
          var value = image[k];
        }

        cache.redis.hset(key, k.toLowerCase(), value);
      }
      
      var key = util.format("%s:images", cache.prefix);
      cache.redis.sadd(key, image.Id);
      cache.redis.expire(key, cache.imageTTL);

      cb();
    }, function(err) {
      if (err) {
        cache.emit('log', 'error', err);
        cache.emit('error', err);
        return;
      }
      
      cache.emit('log', 'debug', util.format('updateImages - host: %s', cache.id));
    });
  });
};

DockerCache.prototype.clearExpiredContainers = function() {
  var cache = this;
  
  var key = util.format("%s:containers", cache.prefix);

  cache.redis.smembers(key, function(err, containers) {
    async.each(containers, function(container, cb) {
      var container_key = util.format("%s:containers:%s", cache.prefix, container)

      cache.redis.exists(container_key, function(err, exists) {
        if (err) {
          cache.emit('log', 'error', err);
          cache.emit('error', err);
          return cb(err);
        }

        if (exists == 0) {
          cache.redis.srem(key, container, function(err, success) {
            if (err) {
              cache.emit('log', 'error', err);
              cache.emit('error', err);
              return cb(err);
            }

            cache.emit('log', 'debug', util.format('clearExpiredContainer - host: %s, container: %s', cache.id, container));
          });
        }
      })
    }, function (err) {
      if (err) {
        cache.emit('log', 'error', err);
        cache.emit('error', err);
        return cb(err);
      }
      
      cb();
    })
  });
};

DockerCache.prototype.refreshHostLastUpdate = function() {
  var cache = this;
  
  var key  = util.format("%s:hosts:%s", cache.prefix, cache.id);
  var time = new Date().getTime();
  
  cache.redis.hset(key, "last_update", time);
};

DockerCache.prototype.clearExpiredHosts = function() {
  var cache = this;
  
  var key = cache.prefix + ":hosts";
  cache.redis.smembers(key, function(err, hosts) {
    if (err) {
      cache.emit('log', 'error', err);
      cache.emit('error', err);
      return;
    }

    async.each(hosts, function(host, cb) {
      var key = util.format("%s:hosts:%s", cache.prefix.host);

      cache.redis.hget(key, "last_update", function(err, last_update) {
        if (err) {
          cb(err);
        }
        
        cache.redis.hget(key, "update_interval", function(err, update_interval) {
          if (err) {
            cb(err);
          }
          
          var timestamp = new Date().getTime();
          
          if ( (timestamp - last_update) > (2 * update_interval) ) {
            cb(null, true)
          }
          
          cb(null, false);
        });

      });
    }, function(err, expired) {
      if (err) {
        cache.emit('log', 'error', err);
        cache.emit('error', err);
      }
      console.log(true);
      if (expired == true) {
        //cache.deleteHost(host);
      }
    });
  });
};


DockerCache.prototype.publishEvent = function() {
  var cache = this;
  
  var args = [];
  for (var arg in arguments) {
    args.push(arguments[arg]);
  }

  var event = args.join(':');
  
  cache.redis.publish(cache.EVENTS_CHANNEL, event);
};


DockerCache.prototype.objectToStringMap = function (object, prefix, tier) {
  var cache = this;
  var out = {};
  
  prefix = prefix || "";
  tier = tier || 0;

  for (var key in object) {
    var name = prefix + key.toLowerCase();  

    if (typeof object[key] == "object" && tier == 1) {
      out[name] = JSON.stringify(object[key]);
    }
    else if (typeof object[key] == "object") {
      var results = cache.objectToStringMap(object[key], name + "_", tier + 1);
      for (var res in results) {
        out[res] = results[res];
      }
    }
    else if (typeof object[key] == "string" || typeof object[key] == "boolean" || typeof object[key] == "number") {
      out[name] = object[key];
    }
  }
  
  return out;
};


module.exports = DockerCache;