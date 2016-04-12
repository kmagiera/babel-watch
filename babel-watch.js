#!/usr/bin/env node

'use strict';

const chokidar = require('chokidar');
const path = require('path');
const babel = require('babel-core');
const fs = require('fs');
const fork = require('child_process').fork;
const commander = require('commander');

const program = new commander.Command("babel-watch");

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

const pkg = require('./package.json');
program.version(pkg.version);
program.usage('[options] [script.js]');
program.parse(process.argv);



let only, ignore;

if (program.only != null) only = babel.util.arrayify(program.only, babel.util.regexify);
if (program.ignore != null) ignore = babel.util.arrayify(program.ignore, babel.util.regexify);

let transpileExtensions = babel.util.canCompile.EXTENSIONS;

if (program.extensions) {
  transpileExtensions = transpileExtensions.concat(babel.util.arrayify(program.extensions));
}

if (program.watch.length === 0) {
  console.error('Nothing to watch');
  process.exit(1);
}

const transformOpts = {
  plugins: program.plugins,
  presets: program.presets,
};

let childApp;
const cwd = process.cwd();

const sources = {};
const maps = {};
const errors = {};

const watcher = chokidar.watch(program.watch, {persistent: true, ignored: program.exclude})
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
  const absoluteFile = path.join(cwd, file);
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
  const absoluteFile = path.join(cwd, file);
  if (!shouldIgnore(absoluteFile)) {
    try {
      const compiled = compile(absoluteFile);
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
  if (Object.keys(errors).length != 0) {
    // There were some transpilation errors, don't start unless solved or invalid file is removed
    return;
  }
  const app = fork(__dirname + '/runner.js');

  app.send({ sources: sources, maps: maps, args: program.args});
  childApp = app;
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

const cache = {};

function compile(filename) {
  const result;

  const optsManager = new babel.OptionManager;

  // merge in base options and resolve all the plugins and presets relative to this file
  optsManager.mergeOptions(transformOpts, 'base', null, path.dirname(filename));

  const opts = optsManager.init({ filename });
  // Do not process config files since has already been done with the OptionManager
  // calls above and would introduce duplicates.
  opts.babelrc = false;
  opts.sourceMap = "both";
  opts.ast = false;

  return babel.transformFileSync(filename, opts);
}
