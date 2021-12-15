#!/usr/bin/env node
// @flow

'use strict';

const chokidar = require('chokidar');
const path = require('path');
const babel = require('@babel/core');
const fs = require('fs');
const os = require('os');
const fork = require('child_process').fork;
const util = require('util');
const execSync = require('child_process').execSync;
const commander = require('commander');
const debounce = require('lodash.debounce');
const isString = require('lodash.isstring');
const isRegExp = require('lodash.isregexp');
const chalk = require('chalk');
const Debug = require('debug');
const stringArgv = require('string-argv').parseArgsStringToArgv;

const debugInit = Debug('babel-watch:init');
const debugCompile = Debug('babel-watch:compile');
const debugWatcher = Debug('babel-watch:watcher');

const DEBOUNCE_DURATION = 100; //milliseconds

const program = new commander.Command("babel-watch");

function collect(val, memo) {
  memo.push(val);
  return memo;
}

// Plucked directly from old Babel Core
// https://github.com/babel/babel/commit/0df0c696a93889f029982bf36d34346a039b1920
function regexify(val) {
  if (!val) return new RegExp('');
  if (Array.isArray(val)) val = val.join("|");
  if (isString(val)) return new RegExp(val || "");
  if (isRegExp(val)) return val;
  throw new TypeError("illegal type for regexify");
};

function arrayify(val) {
  if (!val) return null;
  if (isString(val)) return (val ? val.split(',') : []);
  if (Array.isArray(val)) return val;
  throw new TypeError("illegal type for arrayify");
};

function booleanify(val) {
  if (val === "true" || val == 1) return true;
  if (val === "false" || val == 0 || !val) return false;
  return val;
}

class IgnoredFileError extends Error {};

program.option('-d, --debug [port]', 'Enable debug mode (deprecated) with optional port')
program.option('-B, --debug-brk', 'Enable debug break mode (deprecated)')
program.option('-I, --inspect [address]', 'Enable inspect mode')
program.option('-X, --inspect-brk [address]', 'Enable inspect break mode')
program.option('-o, --only [globs]', 'Matching files will *only* be transpiled', arrayify, null);
program.option('-i, --ignore [globs]', 'Matching files will not be transpiled, but will still be watched. Default value is "node_modules". If you specify this option and still want to exclude modules, be sure to add it to the list.', arrayify, ['node_modules']);
program.option('-e, --extensions [extensions]', 'List of extensions to hook into', arrayify, []);
program.option('-w, --watch [dir]', 'Watch directory "dir" or files. Use once for each directory or file to watch', collect, []);
program.option('-x, --exclude [dir]', 'Exclude matching directory/files from watcher. Use once for each directory or file', collect, []);
program.option('-L, --use-polling', 'In some filesystems watch events may not work correcly. This option enables "polling" which should mitigate this type of issue');
program.option('-D, --disable-autowatch', 'Don\'t automatically start watching changes in files "required" by the program');
program.option('-H, --disable-ex-handler', 'Disable source-map-enhanced uncaught exception handler. You may want to use this option in case your app registers a custom uncaught exception handler');
program.option('-m, --message [string]', 'Set custom message displayed on restart', '>>> Restarting due to change in file(s): %s');
program.option('-c, --config-file [string]', 'Babel config file path');
program.option('--root-mode [mode]', 'The project-root resolution mode. One of \'root\' (the default), \'upward\', or \'upward-optional\'. See https://babeljs.io/docs/en/options#rootmode');
program.option('--clear-console', 'If set, will clear console on each restart. Restart message will not be shown');
program.option('--before-restart <command>', 'Set a custom command to be run before each restart, for example "npm run lint"');
program.option('--restart-timeout <ms>', 'Set the maximum time to wait before forcing a restart. Useful if your app does graceful cleanup.', 2000);
program.option('--no-colors', 'Don\'t use console colors');
program.option('--restart-command <command>', 'Set a string to issue a manual restart. Set to `false` to pass stdin directly to process.', booleanify, 'rs');
program.option('--no-debug-source-maps', 'When using "--inspect" options, inline source-maps are automatically turned on. Set this option to disable that behavior')

const pkg = require('./package.json');
program.version(pkg.version);
program.usage('[options] [script.js] [args]');
program.description('babel-watch is a babel-js node app runner that lets you reload the app on JS source file changes.');
program.on('--help', () => {
  console.log(`
  About "autowatch":

  "Autowatch" is the default behavior in babel-watch. Thanks to that mechanism babel-watch will automatically
  detect files that are "required" (or "imported") by your program and start to watch for changes on those files.
  It means that you no longer need to specify -w (--watch) option with a list of directories you are willing to
  monitor changes in. You can disable "autowatch" with -D option or limit the list of files it will be enabled for
  using the option -x (--exclude).

  IMPORTANT:

  babel-watch is meant to **only** be used during development. In order to support fast reload cycles it uses more
  memory than plain node process. We recommend that when you deploy your app to production you pre-transpile source
  files and run your application using node directly (avoid babel-node too for the same reasons).

  Examples:

    $ babel-watch server.js
    $ babel-watch -x templates server.js
    $ babel-watch server.js --port 8080
    $ babel-watch --inspect -- server.js # \`--\` is required due to parsing ambiguity
    $ babel-watch --inspect-brk -- server.js # \`--\` is required due to parsing ambiguity
    $ babel-watch --inspect-brk 127.0.0.1:9229 server.js

  Debugging:

  If you want to know which file caused a restart, or why a file was not processed, add
  \`env DEBUG="babel-watch:*"\` before your command to see babel-watch internals.

  See more:

  https://github.com/kmagiera/babel-watch
  `);
});
program.parse(process.argv);

const cwd = process.cwd();

const only = program.only;
const ignore = program.ignore;
const configFile = program.configFile ? path.resolve(cwd, program.configFile) : undefined;
const rootMode = program.rootMode;
// We always transpile the default babel extensions. The option only adds more.
const transpileExtensions = babel.DEFAULT_EXTENSIONS.concat(program.extensions.map((ext) => ext.trim()));
const debug = Boolean(program.debug || program.debugBrk || program.inspect || program.inspectBrk)
const restartTimeout = Number.isFinite(program.restartTimeout) ? program.restartTimeout : 2000;

const mainModule = program.args[0];
if (!mainModule) {
  console.error('Main script not specified. If you are using `--inspect` or similar options, please add a `--` like so:');
  console.error('> babel-watch --inspect -- app.js');
  process.exit(1);
}
if (!mainModule.startsWith('.') && !path.isAbsolute(mainModule)) {
  program.args[0] = path.join(cwd, mainModule);
}

let childApp, pipeFd, pipeFilename;

const cache = {};
const errors = {};
const ignored = {};

const watcher = chokidar.watch(program.watch, {
  persistent: true,
  ignored: program.exclude,
  ignoreInitial: true,
  usePolling: program.usePolling,
});
let watcherInitialized = (program.watch.length === 0);
debugInit('Initializing babel-watch with options: %j', program.opts());

process.on('SIGINT', function() {
  debugInit('SIGINT caught, closing.');
  watcher.close();
  killApp();
  process.exit(0);
});

watcher.on('change', handleChange);
watcher.on('add', handleChange);
watcher.on('unlink', handleChange);

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
if (program.restartCommand) {
  const stdin = process.stdin;
  stdin.setEncoding('utf8');
  stdin.on('data', (data) => {
    if (String(data).trim() === program.restartCommand) {
      restartApp();
    }
  });
}

const debouncedRestartApp = debounce(restartApp, DEBOUNCE_DURATION);
let changedFiles = [];

function handleChange(file) {
  const absoluteFile = path.isAbsolute(file) ? file : path.join(cwd, file);
  const isUsed = Boolean(cache[absoluteFile] || errors[absoluteFile]);
  const isIgnored = shouldIgnore(file);
  if (isUsed) {
    delete cache[absoluteFile];
    delete errors[absoluteFile];
  }
  if (!isIgnored) {
    changedFiles.push(file); // for logging
    // file is in use by the app or explicitly watched, let's restart!
    debouncedRestartApp();
  }
  debugWatcher('Change detected in file: %s. File used by program (%s). File ignored (%s).', file, isUsed, isIgnored);
}

function generateTempFilename() {
  const now = new Date();
  return path.join(os.tmpdir(), [
    now.getFullYear(), now.getMonth(), now.getDate(),
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
      debugCompile('Compiled file: %s. Success? %s', filename, !err);

      if (!result && !err) err = new Error('No Result from Babel for file: ' + filename);
      if (err || !result) {
        // Intentional ignore
        if (err instanceof IgnoredFileError) {
          ignored[filename] = true;
          debugCompile('File %s ignored due to extension or intentional ignore rule.', filename);
          return callback();
        }
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

// Kills the child app. Accepts a callback if you want to start again
// once it's dead.
function killApp(cb) {
  let exited = false;
  // Bail out; not started yet or already killed
  if (!childApp) {
    onExit();
    return;
  }

  function clearState() {
    if (pipeFd) fs.closeSync(pipeFd); // silently close pipe fd
    pipeFd = undefined;
    if (pipeFilename) fs.unlinkSync(pipeFilename); // silently remove old pipe file
    pipeFilename = undefined;
    childApp = undefined;
  }

  function onExit() {
    if (exited) return;
    exited = true;
    clearState();
    cb && cb();
  }

  // Are we still running?
  //
  // From https://nodejs.org/api/process.html#processkillpid-signal
  //
  // This method will throw an error if the target pid does not exist.
  // As a special case, a signal of 0 can be used to test for the existence of a process.
  //
  let isRunning = true;
  try {
    process.kill(childApp.pid, 0);
  } catch (e) {
    isRunning = false;
  }
  if (isRunning) {
    // Restart once it exits
    childApp.once('exit', onExit);

    // It's still running. Try to politely kill it.
    try {
      childApp.kill('SIGHUP');
    } catch (error) {
      childApp.kill('SIGKILL');
    }

    // It will restart when the signal comes through.
    // However, if the child is listening to SIGHUP and ignoring it or cleaning up,
    // set a timer to ensure we do actually call this closed.
    // Use option `--restart-timeout` to adjust the timeout here.
    setTimeout(() => {
      if (exited) return;
      // Is it still around? If so, make sure it dies.
      if (childApp) {
        log('Child app took too long to close. Force-restarting...');
        childApp.kill('SIGKILL');
      }
      onExit();
    }, restartTimeout);
  } else {
    // It was dead, so just call back.
    onExit();
  }
}

function restartApp() {
  if (!watcherInitialized) return;
  if (childApp) {
    if (program.clearConsole) console.clear();
    else if (program.message) {
      let message = program.message;
      // Include changed files when possible.
      if (message.includes('%s')) message = util.format(message, changedFiles.join(','));
      log(message);
    }
  }
  // kill app early as `compile` may take a while
  // If this is the first run, it will bail out and call back
  killApp(() => {
    restartAppInternal();
  });
}

function log(...msg) {
  const preamble = program.colors ? chalk.blue.bold.underline('babel-watch:') : '>>> babel-watch:';
  console.log(preamble, ...msg);
}

function restartAppInternal() {
  if (Object.keys(errors).length != 0) {
    // There were some transpilation errors, don't start unless solved or invalid file is removed
    return;
  }

  changedFiles = []; // reset state
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
    runnerExecArgv.push(typeof(program.debug) === 'boolean'
      ? `--debug`
      : `--debug=${program.debug}`
    )
  }
  // Support for --debug-brk option
  if (program.debugBrk) {
    runnerExecArgv.push('--debug-brk');
  }
  // Support for --inspect option
  if (program.inspect) {
    // Somehow, the default port (2992) is being passed from the node command line. Wipe it out.
    const inspectArg = typeof(program.inspect) === 'boolean'
     ? `--inspect`
     : `--inspect=${program.inspect}`
    runnerExecArgv.push(inspectArg);
  }
  // Support for --inspect-brk option
  if (program.inspectBrk) {
    const inspectBrkArg = typeof(program.inspectBrk) === 'boolean'
    ? `--inspect-brk`
    : `--inspect-brk=${program.inspectBrk}`
    runnerExecArgv.push(inspectBrkArg)
  }

  if (program.beforeRestart) {
    log(`Running command "${program.beforeRestart}" before restart.`);
    execSync(program.beforeRestart, {stdio: 'inherit'}); // pass stdio to console
  }

  // Pass options into execargv for easy use of options like `--trace-exit`.
  // You can use NODE_OPTIONS to pass the option to both the watcher and the child,
  // or `BABEL_WATCH_NODE_OPTIONS` to only pass it to the child.
  if (process.env.BABEL_WATCH_NODE_OPTIONS) {
    runnerExecArgv.push(...stringArgv(process.env.BABEL_WATCH_NODE_OPTIONS));
  }

  const runnerPath = path.resolve(__dirname, 'runner.js');
  const app = fork(runnerPath, {
    execArgv: runnerExecArgv,
  });

  app.on('message', (data) => {
    if (!data || data.event !== 'babel-watch-filename') return;
    const filename = data.filename;
    if (!program.disableAutowatch) {
      // use relative path for watch.add as it would let chokidar reconsile exclude patterns
      const relativeFilename = path.relative(cwd, filename);
      watcher.add(relativeFilename);
    }
    handleFileLoad(filename, (source, sourceMap) => {
      const sourceBuf = Buffer.from(source || '');
      const mapBuf = Buffer.from(sourceMap ? JSON.stringify(sourceMap) : []);
      const lenBuf = Buffer.alloc(4);
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

  app.on('exit', (code, signal) => {
    log('Runner closed with', {code, signal});
  });

  app.send({
    event: 'babel-watch-start',
    pipe: pipeFilename,
    args: program.args,
    debug,
    handleUncaughtExceptions: !program.disableExHandler,
    transpileExtensions,
  });
  pipeFd = fs.openSync(pipeFilename, 'w');
  childApp = app;
}

// Only ignore based on extension for now, which we keep track of on our own for file watcher
// purposes. `ignore` and `only` are passed to `babel.OptionManager` to let it make its own
// determinations.
function shouldIgnore(filename) {
  if (!transpileExtensions.includes(path.extname(filename))) {
    return true;
  } else if (ignored[filename]) {
    // ignore cache for extra speed
    return true;
  }
  return false;
}

function compile(filename, callback) {
  const opts = new babel.OptionManager().init({ filename, ignore, only, configFile, rootMode });

  // If opts is not present, the file is ignored, either by explicit input into
  // babel-watch or by `.babelignore`.
  if (!opts) {
    return callback(new IgnoredFileError());
  }
  // Do not process config files since has already been done with the OptionManager
  // calls above and would introduce duplicates.
  opts.babelrc = false;
  opts.sourceMaps = (debug && program.debugSourceMaps) ?  'inline' : true;
  opts.ast = false;

  return babel.transformFile(filename, opts, (err, result) => {
    callback(err, result);
  });
}

restartApp();


process.on('unhandledException', (e) => {
  log('Unhandled exception:', e);
})
