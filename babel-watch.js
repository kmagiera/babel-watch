#!/usr/bin/env node

'use strict';

const chokidar = require('chokidar');
const path = require('path');
const babel = require('babel-core');
const fs = require('fs');
const os = require('os');
const util = require('util');
const fork = require('child_process').fork;
const execSync = require('child_process').execSync;
const commander = require('commander');
const debounce = require('lodash.debounce');

const RESTART_COMMAND = 'rs';
const DEBOUNCE_DURATION = 100; //milliseconds

const program = new commander.Command("babel-watch");

function collect(val, memo) {
  memo.push(val);
  return memo;
}

program.option('-d, --debug [port]', 'Set debugger port')
program.option('-B, --debug-brk', 'Enable debug break mode')
program.option('-I, --inspect', 'Enable inspect mode')
program.option('-o, --only [globs]', 'Matching files will be transpiled');
program.option('-i, --ignore [globs]', 'Matching files will not be transpiled');
program.option('-e, --extensions [extensions]', 'List of extensions to hook into [.es6,.js,.es,.jsx]');
program.option('-p, --plugins [string]', '', babel.util.list);
program.option('-b, --presets [string]', '', babel.util.list);
program.option('-w, --watch [dir]', 'Watch directory "dir" or files. Use once for each directory or file to watch', collect, []);
program.option('-x, --exclude [dir]', 'Exclude matching directory/files from watcher. Use once for each directory or file.', collect, []);
program.option('-L, --use-polling', 'In some filesystems watch events may not work correcly. This option enables "polling" which should mitigate this type of issues');
program.option('-D, --disable-autowatch', 'Don\'t automatically start watching changes in files "required" by the program');
program.option('-H, --disable-ex-handler', 'Disable source-map-enhanced uncaught exception handler. (you may want to use this option in case your app registers a custom uncaught exception handler)');
program.option('-m, --message [string]', 'Set custom message displayed on restart (default is ">>> RESTARTING <<<")');

const pkg = require('./package.json');
program.version(pkg.version);
program.usage('[options] [script.js] [args]');
program.description('babel-watch is a babel-js node app runner that lets you reload the app on JS source file changes.');
program.on('--help', () => {
  console.log(`\
  About "autowatch":

  "Autowatch" is the default behavior in babel-watch. Thanks to that mechanism babel-watch will automatically
  detect files that are "required" (or "imported") by your program and start to watch for changes on those files.
  It means that you no longer need to specify -w (--watch) option with a list of directories you are willing to
  monitor changes in. You can disable "autowatch" with -D option or limit the list of files it will be enabled for
  using the option -x (--exclude).

  Babel.js configuration:

  You may use some of the options listed above to customize plugins/presets and matching files that babel.js
  is going to use while transpiling your app's source files but we recommend that you use .babelrc file as
  babel-watch works with .babelrc just fine.

  IMPORTANT:

  babel-watch is meant to **only** be used during development. In order to support fast reload cycles it uses more
  memory than plain node process. We recommend that when you deploy your app to production you pre-transpile source
  files and run your application using node directly (avoid babel-node too for the same reasons).

  Examples:

    $ babel-watch server.js
    $ babel-watch -x templates server.js
    $ babel-watch --presets es2015 server.js --port 8080

  See more:

  https://github.com/kmagiera/babel-watch
  `);
});
program.parse(process.argv);

const cwd = process.cwd();

let only, ignore;

if (program.only != null) only = babel.util.arrayify(program.only, babel.util.regexify);
if (program.ignore != null) ignore = babel.util.arrayify(program.ignore, babel.util.regexify);

let transpileExtensions = babel.util.canCompile.EXTENSIONS;

if (program.extensions) {
  transpileExtensions = transpileExtensions.concat(babel.util.arrayify(program.extensions));
}

const mainModule = program.args[0];
if (!mainModule) {
  console.error('Main script not specified');
  process.exit(1);
}
if (!mainModule.startsWith('.') && !mainModule.startsWith('/')) {
  program.args[0] = path.join(cwd, mainModule);
}

const transformOpts = {
  plugins: program.plugins,
  presets: program.presets,
};

let childApp, pipeFd, pipeFilename;

const cache = {};
const errors = {};

const watcher = chokidar.watch(program.watch, {
  persistent: true,
  ignored: program.exclude,
  ignoreInitial: true,
  usePolling: program.usePolling,
});
let watcherInitialized = (program.watch.length === 0);

process.on('SIGINT', function() {
  watcher.close();
  killApp();
  process.exit(0);
});

const debouncedHandleChange = debounce(handleChange, DEBOUNCE_DURATION);

watcher.on('change', debouncedHandleChange);
watcher.on('add', debouncedHandleChange);
watcher.on('unlink', debouncedHandleChange);

watcher.on('ready', () => {
  if (!watcherInitialized) {
    watcherInitialized = true;
    restartApp();
  }
});

watcher.on('error', error => {
  console.error('Watcher failure', error);
  process.exit(1);
});

// Restart the app when a sequence of keys has been pressed ('rs' by refault)
const stdin = process.stdin;
stdin.setEncoding('utf8');
stdin.on('data', (data) => {
  if (String(data).trim() === RESTART_COMMAND) {
    restartApp();
  }
});

function handleChange(file) {
  const absoluteFile = file.startsWith('/') ? file : path.join(cwd, file);
  delete cache[absoluteFile];
  delete errors[absoluteFile];

  // file is in use by the app, let's restart!
  restartApp();
}

function generateTempFilename() {
  const now = new Date();
  return path.join(os.tmpdir(), [
    now.getYear(), now.getMonth(), now.getDate(),
    '-',
    process.pid,
    '-',
    (Math.random() * 0x100000000 + 1).toString(36),
  ].join(''));
}

function handleFileLoad(filename, callback) {
  const cached = cache[filename];
  if (cached) {
    const stats = fs.statSync(filename);
    if (stats.mtime.getTime() === cached.mtime) {
      callback(cache[filename].code, cache[filename].map);
      return;
    }
  }
  if (!shouldIgnore(filename)) {
    compile(filename, (err, result) => {
      if (err) {
        console.error('Babel compilation error', err.stack);
        errors[filename] = true;
        return;
      }
      const stats = fs.statSync(filename);
      cache[filename] = {
        code: result.code,
        map: result.map,
        mtime: stats.mtime.getTime(),
      };
      delete errors[filename];
      callback(result.code, result.map);
    });
  } else {
    callback();
  }
}

function killApp() {
  if (childApp) {
    const currentPipeFd = pipeFd;
    const currentPipeFilename = pipeFilename;

    let hasRestarted = false;
    const restartOnce = () => {
      if (hasRestarted) return;
      hasRestarted = true;
      if (currentPipeFd) {
        fs.closeSync(currentPipeFd); // silently close pipe fd
      }
      if (pipeFilename) {
        fs.unlinkSync(pipeFilename); // silently remove old pipe file
      }
      pipeFd = undefined;
      childApp = undefined;
      pipeFilename = undefined;
      restartAppInternal();
    };
    childApp.on('exit', restartOnce);
    let isRunning = true;
    try {
      process.kill(childApp.pid, 0);
    } catch (e) {
      isRunning = false;
    }
    if (isRunning) {
      try {
        childApp.kill('SIGHUP');
      } catch (error) {
        childApp.kill('SIGKILL');
      }
      pipeFd = undefined;
      pipeFilename = undefined;
      childApp = undefined;
    } else {
      pipeFd = undefined;
      pipeFilename = undefined;
      childApp = undefined;
      restartOnce();
    }
  }
}

function prepareRestart() {
  if (watcherInitialized && childApp) {
    // kill app early as `compile` may take a while
    var restartMessage = program.message ? program.message : ">>> RESTARTING <<<";
    console.log(restartMessage);
    killApp();
  } else {
    restartAppInternal();
  }
}

function restartApp() {
  if (!watcherInitialized) return;
  prepareRestart();
}

function restartAppInternal() {
  if (Object.keys(errors).length != 0) {
    // There were some transpilation errors, don't start unless solved or invalid file is removed
    return;
  }

  pipeFilename = generateTempFilename();

  if (os.platform() === 'win32') {
    try {
      execSync(`echo. > ${pipeFilename}`);
    } catch (e) {
      console.error(`Unable to create file ${pipeFilename}`);
      process.exit(1);
    }
  } else {
    try {
      execSync(`mkfifo -m 0666 ${pipeFilename}`);
    } catch (e) {
      console.error('Unable to create named pipe with mkfifo. Are you on linux/OSX?');
      process.exit(1);
    }
  }

  // Support for --debug option
  const runnerExecArgv = process.execArgv.slice();
  if (program.debug) {
    runnerExecArgv.push('--debug=' + program.debug);
  }
  // Support for --inspect option
  if (program.inspect) {
    runnerExecArgv.push('--inspect');
  }
  // Support for --debug-brk
  if(program.debugBrk) {
    runnerExecArgv.push('--debug-brk');
  }

  const app = fork(path.resolve(__dirname, 'runner.js'), { execArgv: runnerExecArgv });

  app.on('message', (data) => {
    if (!data || data.event !== 'babel-watch-filename') return;
    const filename = data.filename;
    if (!program.disableAutowatch) {
      // use relative path for watch.add as it would let chokidar reconsile exclude patterns
      const relativeFilename = path.relative(cwd, filename);
      watcher.add(relativeFilename);
    }
    handleFileLoad(filename, (source, sourceMap) => {
      const sourceBuf = new Buffer(source || 0);
      const mapBuf = new Buffer(sourceMap ? JSON.stringify(sourceMap) : 0);
      const lenBuf = new Buffer(4);
      if (pipeFd) {
        try {
          lenBuf.writeUInt32BE(sourceBuf.length, 0);
          fs.writeSync(pipeFd, lenBuf, 0, 4);
          sourceBuf.length && fs.writeSync(pipeFd, sourceBuf, 0, sourceBuf.length);

          lenBuf.writeUInt32BE(mapBuf.length, 0);
          fs.writeSync(pipeFd, lenBuf, 0, 4);
          mapBuf.length && fs.writeSync(pipeFd, mapBuf, 0, mapBuf.length);
        } catch (error) {
          // EPIPE means `pipeFd` has been closed. We can ignore this
          if (error.code !== 'EPIPE') {
            throw error;
          }
        }
      }
    });
  });

  app.send({
    event: 'babel-watch-start',
    pipe: pipeFilename,
    args: program.args,
    handleUncaughtExceptions: !program.disableExHandler,
    transpileExtensions: transpileExtensions,
  });
  pipeFd = fs.openSync(pipeFilename, 'w');
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

function compile(filename, callback) {
  const optsManager = new babel.OptionManager;

  // merge in base options and resolve all the plugins and presets relative to this file
  optsManager.mergeOptions({
    options: transformOpts,
    alias: 'base',
    loc: path.dirname(filename)
  });

  const opts = optsManager.init({ filename });
  // Do not process config files since has already been done with the OptionManager
  // calls above and would introduce duplicates.
  opts.babelrc = false;
  opts.sourceMap = true;
  opts.ast = false;

  return babel.transformFile(filename, opts, (err, result) => {
    callback(err, result);
  });
}

restartApp();
