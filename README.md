[![npm](https://img.shields.io/npm/dt/docker-cache.svg)](https://github.com/ekristen/node-docker-cache) [![npm](https://img.shields.io/npm/l/docker-cache.svg)](https://github.com/ekristen/docker-cache) [![David](https://img.shields.io/david/ekristen/node-docker-cache.svg)](https://github.com/ekristen/node-docker-cache) [![David](https://img.shields.io/david/dev/ekristen/node-docker-cache.svg)](https://github.com/ekristen/node-docker-cache)

# Docker Cache

Full Disclosure: This project was inspired by Sam Alba's GoLang Docker Cache project and most of the code was ported from Go over to Node.JS.  A lot of the readme is borrowed from the https://github.com/samalba/docker-cache because it uses the same data pattern. samalba's project is no longer maintained and Node.JS played more to my strengths, hence the rewrite. Much of this readme is also from his original project and/or inspired by it.

The purpose of the docker cache application is to monitor docker instances and populate a redis server with information about the containers and images that exist on that docker instance. Docker Cache can be used to monitor just one or multiple docker instances provided they are accessible via tcp port. 

## Why?

Docker-Cache brings full visibility on what is happening on your cluster in real-time:

 * How many Docker hosts are running?
 * How many containers on each of them?
 * What is the configuration for each container?

Those data are updated in realtime and you can access them quickly in one location (Redis).

The Cache server is volatile, you can lose the dataset, the data will be repopulated quickly as long as there is a Cache server running.

