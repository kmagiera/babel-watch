#!/usr/bin/env node

'use strict';

let chokidar = require('chokidar');
let path = require('path');
let babel = require('babel-core');
let _ = require('lodash');
let fs = require('fs');
let fork = require('child_process').fork;
let commander = require('commander');

let program = new commander.Command("babel-watch");

function collect(val, memo) {
  memo.push(val);
  return memo;
}

program.option('-o, --only [globs]', 'Matching files will be transpiled');
program.option('-i, --ignore [globs]', 'Matching files will not be transpiled');
program.option('-e, --extensions [extensions]', 'List of extensions to hook into [.es6,.js,.es,.jsx]');
program.option('-p, --plugins [string]', '', babel.util.list);
program.option('-b, --presets [string]', '', babel.util.list);
program.option('-w, --watch [dir]', 'Watch directory "dir" or files. Use once for each directory or file to watch', collect, []);
program.option('-x, --exclude [dir]', 'Exclude matching directory/files from watcher. Use once for each directory or file.', collect, []);

let pkg = require('./package.json');
program.version(pkg.version);
program.usage('[options] [script.js]');
program.parse(process.argv);

let only, ignore;

if (program.only != null) only = babel.util.arrayify(program.only, babel.util.regexify);
if (program.ignore != null) ignore = babel.util.arrayify(program.ignore, babel.util.regexify);

let transpileExtensions = babel.util.canCompile.EXTENSIONS;

if (program.extensions) {
  transpileExtensions = _.concat(transpileExtensions, babel.util.arrayify(program.extensions));
}

if (program.watch.length === 0) {
  console.error('Nothing to watch');
  process.exit(1);
}

let transformOpts = {
  plugins: program.plugins,
  presets: program.presets,
};

let childApp;
let cwd = process.cwd();

let sources = {};
let maps = {};
let errors = {};

let watcher = chokidar.watch(program.watch, {persistent: true, ignored: program.exclude})
let watcherInitialized = false;

process.on('SIGINT', function() {
  watcher.close();
  process.exit(1);
});

watcher.on('change', processAndRestart);
watcher.on('add', processAndRestart);

watcher.on('ready', () => {
  watcherInitialized = true;
  restartApp();
});

watcher.on('unlink', file => {
  let absoluteFile = path.join(cwd, file);
  if (sources[absoluteFile]) {
    delete sources[absoluteFile];
    delete maps[absoluteFile];
    delete errors[absoluteFile];
  }
  if (watcherInitialized) {
    restartApp();
  }
});

watcher.on('error', error => {
  console.error('Watcher failure', error);
  process.exit(1);
});

function processAndRestart(file) {
  if (watcherInitialized && childApp) {
    // kill app early as `compile` may take a while
    console.log(">>> RESTARTING <<<");
    childApp.kill('SIGHUP');
    childApp = undefined;
  }
  let absoluteFile = path.join(cwd, file);
  if (!shouldIgnore(absoluteFile)) {
    try {
      let compiled = compile(absoluteFile);
      sources[absoluteFile] = compiled.code;
      maps[absoluteFile] = compiled.map;
      delete errors[absoluteFile];
    } catch (err) {
      console.error('Babel compilation error', err.stack);
      errors[absoluteFile] = true;
      return;
    }
  }
  if (watcherInitialized) {
    restartApp();
  }
}

function restartApp() {
  if (childApp) {
    childApp.kill('SIGHUP');
    childApp = undefined;
  }
  if (!_.isEmpty(errors)) {
    // There were some transpilation errors, don't start unless solved or invalid file is removed
    return;
  }
  let app = fork(__dirname + '/runner.js');

  app.send({ sources: sources, maps: maps, args: program.args});
  childApp = app;
}

function mtime(filename) {
  return +fs.statSync(filename).mtime;
}

function shouldIgnore(filename) {
  if (transpileExtensions.indexOf(path.extname(filename)) < 0) {
    return true;
  } else if (!ignore && !only) {
    // Ignore node_modules by default
    return path.relative(cwd, filename).split(path.sep).indexOf('node_modules') >= 0;
  } else {
    return babel.util.shouldIgnore(filename, ignore || [], only);
  }
}

let cache = {};

function compile(filename) {
  let result;

  let optsManager = new babel.OptionManager;

  // merge in base options and resolve all the plugins and presets relative to this file
  optsManager.mergeOptions(_.cloneDeep(transformOpts), 'base', null, path.dirname(filename));

  let opts = optsManager.init({ filename });

  return babel.transformFileSync(filename, _.extend(opts, {
    // Do not process config files since has already been done with the OptionManager
    // calls above and would introduce duplicates.
    babelrc: false,
    sourceMap: "both",
    ast:       false
  }));
}
