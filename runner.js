'use strict';

let path = require('path');
let sourceMapSupport = require('source-map-support');

let sources = {};
let maps = {};

function loader(module_, filename, defaultHandler) {
  let source = sources[filename];
  if (source) {
    module_._compile(source, filename);
  } else {
    defaultHandler(module_, filename);
  }
}

function replaceExtensionHooks() {
  for (let ext in require.extensions) {
    let defaultHandler = require.extensions[ext]
    require.extensions[ext] = (module_, filename) => {
      loader(module_, filename, defaultHandler);
    };
  }
}

replaceExtensionHooks();

process.on('message', function(data) {
  sources = data.sources;
  maps = data.maps;

  let filename = data.args[0];
  if (filename.charAt(0) !== '/') {
    data.args[0] = path.join(process.cwd(), filename);
  }
  process.argv = ["node"].concat(data.args);
  require('module').runMain();
});

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  retrieveSourceMap(filename) {
    let map = maps && maps[filename];
    if (map) {
      return {
        url: null,
        map: map
      };
    } else {
      return null;
    }
  }
});
