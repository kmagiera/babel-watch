# babel-watch

Reload your babel-node app on JS source file changes. And do it *fast*.

## Why should I use it?

If you're tired of using [`babel-node`](https://github.com/babel/babel/tree/master/packages/babel-cli) together with [`nodemon`](https://github.com/remy/nodemon) (or similar solution). The reason why the aforementioned setup performs so badly is the startup time of `babel-node` itself. `babel-watch` only starts `babel` in the "master" process where it also starts the file watcher. The transpilation is performed in that process too. On file-watcher events, it spawns a pure `node` process and passed transpiled code from the parent process together with the source maps. This allows us to avoid loading `babel` and all its deps every time we restart the JS script/app.

## I want it

Just install it and add to your package:
```bash
  npm install --save-dev babel-watch
```

(Make sure you have `babel` installed as dependency in your project as `babel-watch` only defines `babel` as a "peerDependency")

Then use `babel-watch` in your `package.json` in scripts section like this:
```json
  "scripts": {
    "start": "babel-watch -w src src/main.js"
  }
```

## Options

`babel-watch` was made to be compatible with `babel-node` and `nodemon` options. Not all of them are supported yet, here is a short list of supported command line options:

```
    -o, --only [globs]             Matching files will be transpiled
    -i, --ignore [globs]           Matching files will not be transpiled
    -e, --extensions [extensions]  List of extensions to hook into [.es6,.js,.es,.jsx]
    -p, --plugins [string]
    -b, --presets [string]
    -w, --watch [dir]              Watch directory "dir" or files. Use once for each directory or file to watch
    -x, --exclude [dir]            Exclude matching directory/files from watcher. Use once for each directory or file.
    -V, --version                  output the version number
```

### Example usage:

```bash
  babel-watch --watch src --watch *.js --exclude src/schema.graphql app.js
```

Watch for all js files in current directory + all files under `src` directory but ignore file `src/schema.graphql`, whenever one of those files updates restart `app.js` script.

## Demo

Demo of `nodemod + babel-node` (on the left) and `babel-watch` reloading simple `express` based app:

![](https://raw.githubusercontent.com/kmagiera/babel-watch/master/docs/demo.gif)

## Important information

Using `babel-node` or `babel-watch` is not recommended in production environment. For the production use it is much better practice to build your node application using `babel` and run it using just `node`.

## Contributing

All PRs are welcome!
