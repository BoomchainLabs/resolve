var isCore = require('is-core-module');
var fs = require('fs');
var path = require('path');
/** @type {(c: unknown) => c is string} */
var isCategory = require('node-exports-info/isCategory');
var getCategoriesForRange = require('node-exports-info/getCategoriesForRange');
var getHomedir = require('./homedir');
var caller = require('./caller');
var nodeModulesPaths = require('./node-modules-paths');
var normalizeOptions = require('./normalize-options');

var validateExportsObject = require('validate-exports-object');

var realpathFS = process.platform !== 'win32' && fs.realpathSync && typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;

var relativePathRegex = /^(?:\.\.?(?:\/|$)|\/|([A-Za-z]:)?[/\\])/;
var windowsDriveRegex = /^\w:[/\\]*$/;
var nodeModulesRegex = /[/\\]node_modules[/\\]*$/;

var homedir = getHomedir();
var defaultPaths = function () {
    return [
        path.join(homedir, '.node_modules'),
        path.join(homedir, '.node_libraries')
    ];
};

var defaultIsFile = function isFile(file) {
    try {
        var stat = fs.statSync(file, { throwIfNoEntry: false });
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
        throw e;
    }
    return !!stat && (stat.isFile() || stat.isFIFO());
};

var defaultIsDir = function isDirectory(dir) {
    try {
        var stat = fs.statSync(dir, { throwIfNoEntry: false });
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
        throw e;
    }
    return !!stat && stat.isDirectory();
};

var defaultRealpathSync = function realpathSync(x) {
    try {
        return realpathFS(x);
    } catch (realpathErr) {
        if (realpathErr.code !== 'ENOENT') {
            throw realpathErr;
        }
    }
    return x;
};

var maybeRealpathSync = function maybeRealpathSync(realpathSync, x, opts) {
    if (!opts || !opts.preserveSymlinks) {
        return realpathSync(x);
    }
    return x;
};

var defaultReadPackageSync = function defaultReadPackageSync(readFileSync, pkgfile) {
    return JSON.parse(readFileSync(pkgfile));
};

var getPackageCandidates = function getPackageCandidates(x, start, opts) {
    var dirs = nodeModulesPaths(start, opts, x);
    for (var i = 0; i < dirs.length; i++) {
        dirs[i] = path.join(dirs[i], x);
    }
    return dirs;
};

var categoryMessage = '`resolution` must be `true`, a semver range string, `{ category }` with a known node “exports” category (' + getCategoriesForRange('*').join(', ') + '), or `{ engines: true }`';

var cjsConditions = ['require', 'node', 'default'];
var cjsExtensions = ['.js']; // , '.cjs', '.json'];
// var esmConditions = ['import', 'node', 'default'];
// var esmExtensions = ['.mjs'];

module.exports = function resolveSync(x, options) {
    if (typeof x !== 'string') {
        throw new TypeError('Path must be a string.');
    }
    var opts = normalizeOptions(x, options);

    if (process.env.C) {
        opts.resolution = { category: process.env.C };
    }
    var categories = ['pre-exports']; // TODO: v1, 'pre-exports', v2, `getCategoriesForRange(process.version)`
    var conditions = cjsConditions;
    // process.version | 'semver range' | { engines: true } | { category: enum } | { version: 'semver range' }
    if ('resolution' in opts) {
        if (!opts.resolution) {
            throw new TypeError(categoryMessage);
        }
        if (typeof opts.resolution === 'string') { // current version
            categories = getCategoriesForRange(opts.resolution);
        } else if (typeof opts.resolution === 'object') {
            /** @type {unknown} */
            var engines = opts.resolution.engines;
            /** @type {unknown} */
            var cat = opts.resolution.category;
            if (
                (typeof engines !== 'undefined' && typeof cat !== 'undefined')
                || (typeof cat !== 'undefined' && !isCategory(cat))
                || (typeof engines !== 'undefined' && engines !== true)
            ) {
                throw new TypeError(categoryMessage);
            }
            categories = engines || [cat];
            if ('conditions' in opts.resolution) {
                if (typeof cat !== 'undefined' && (categories.includes('pre-exports') || categories.includes('broken'))) {
                    throw new TypeError('`conditions` is not supported for the `pre-exports` or `broken` categories');
                }
                if (!Array.isArray(opts.resolution.conditions)) { // TODO: check .every
                    throw new TypeError('`conditions` must be an array of strings');
                }
                conditions = opts.resolution.conditions;
            }
        }
    }

    var isFile = opts.isFile || defaultIsFile;
    var isDirectory = opts.isDirectory || defaultIsDir;
    var readFileSync = opts.readFileSync || fs.readFileSync;
    var realpathSync = opts.realpathSync || defaultRealpathSync;
    var readPackageSync = opts.readPackageSync || defaultReadPackageSync;
    if (opts.readFileSync && opts.readPackageSync) {
        throw new TypeError('`readFileSync` and `readPackageSync` are mutually exclusive.');
    }
    var packageIterator = opts.packageIterator;

    var extensions = opts.extensions || cjsExtensions;
    var includeCoreModules = opts.includeCoreModules !== false;
    var basedir = opts.basedir || path.dirname(caller());
    var parent = opts.filename || basedir;

    opts.paths = opts.paths || defaultPaths();

    // ensure that `basedir` is an absolute path at this point, resolving against the process' current working directory
    var absoluteStart = maybeRealpathSync(realpathSync, path.resolve(basedir), opts);

    if (opts.basedir && !isDirectory(absoluteStart)) {
        var dirError = new TypeError('Provided basedir "' + opts.basedir + '" is not a directory' + (opts.preserveSymlinks ? '' : ', or a symlink to a directory'));
        dirError.code = 'INVALID_BASEDIR';
        throw dirError;
    }

    if (relativePathRegex.test(x)) {
        var res = path.resolve(absoluteStart, x);
        if (x === '.' || x === '..' || x.slice(-1) === '/') res += '/';
        var m = loadAsFileSync(res) || loadAsDirectorySync(res);
        if (m) return maybeRealpathSync(realpathSync, m, opts);
    } else if (includeCoreModules && isCore(x)) {
        return x;
    } else {
        var n = loadNodeModulesSync(x, absoluteStart);
        if (n) return maybeRealpathSync(realpathSync, n, opts);
    }

    var err = new Error("Cannot find module '" + x + "' from '" + parent + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;

    function loadAsFileSync(x) {
        var pkg = loadpkg(path.dirname(x));

        if (pkg && pkg.dir && pkg.pkg && opts.pathFilter) {
            var rfile = path.relative(pkg.dir, x);
            var r = opts.pathFilter(pkg.pkg, x, rfile);
            if (r) {
                x = path.resolve(pkg.dir, r); // eslint-disable-line no-param-reassign
            }
        }

        if (isFile(x)) {
            return x;
        }

        for (var i = 0; i < extensions.length; i++) {
            var file = x + extensions[i];
            if (isFile(file)) {
                return file;
            }
        }
    }

    function loadpkg(dir) {
        if (dir === '' || dir === '/') return;
        if (process.platform === 'win32' && windowsDriveRegex.test(dir)) {
            return;
        }
        if (nodeModulesRegex.test(dir)) return;

        var pkgfile = path.join(isDirectory(dir) ? maybeRealpathSync(realpathSync, dir, opts) : dir, 'package.json');

        if (!isFile(pkgfile)) {
            return loadpkg(path.dirname(dir));
        }

        var pkg;
        try {
            pkg = readPackageSync(readFileSync, pkgfile);
        } catch (e) {
            if (!(e instanceof SyntaxError)) {
                throw e;
            }
        }

        if (pkg && opts.packageFilter) {
            pkg = opts.packageFilter(pkg, pkgfile, dir);
        }

        return { pkg: pkg, dir: dir };
    }

    function resolveExportsItem(pkgDir, item, x) {
        if (typeof item === 'string') {
            var f = loadAsFileSync(path.join(pkgDir, item));
            if (f) return f;
        } else if (Array.isArray(item)) {
            for (var i = 0; i < item.length; i += 1) {
                var itemResult = resolveExportsItem(pkgDir, item[i], x);
                if (itemResult) { return itemResult; }
            }
        } else if (!categories.includes('broken') && item && typeof item === 'object') { // "broken" only supports string and array forms
            var result = validateExportsObject(item);
            var relativeX = path.relative(x, basedir) || '.';
            if (result.problems.length > 0 || !result.status || result.status === 'empty') {
                var notInExportsError = new Error("Package subpath '" + relativeX + "' is not defined by \"exports\" in '" + path.join(pkgDir, 'package.json') + '"');
                notInExportsError.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
                notInExportsError.cause = result.problems;
                throw notInExportsError;
            }
            if (result.status === 'conditions') {
                var conditionResult;
                for (var ci = 0; !conditionResult && ci <= conditions.length; ci += 1) {
                    conditionResult = resolveExportsItem(pkgDir, item[conditions[ci]], x);
                }
                if (conditionResult) {
                    return conditionResult;
                }
            } else if (result.status === 'files') {
                for (var key in item) { // eslint-disable-line no-restricted-syntax
                    if (Object.prototype.hasOwnProperty.call(item, key)) {
                        var isMatch = key === '.' ? x === (pkgDir + path.sep) : path.join(pkgDir, key) === x;
                        if (!isMatch) {
                            continue; // eslint-disable-line no-continue, no-restricted-syntax
                        }

                        // TODO check if ends in slash
                        if (key[key.length - 1] === path.sep || key[key.length - 1] === '/') {
                            if (categories.includes('broken-dir-slash-conditions') || categories.includes('pattern-trailers-no-dir-slash')) {
                                continue; // eslint-disable-line no-continue, no-restricted-syntax
                            }
                        }

                        // TODO check if ends in *
                        console.log('trace');
                        var keyResult = resolveExportsItem(pkgDir, item[key], x);
                        if (keyResult) { return keyResult; }
                    }
                }
            }
        }
    }

    function loadAsDirectorySync(x) {
        /* eslint max-depth: 0 */
        var pkgDir = isDirectory(x) ? maybeRealpathSync(realpathSync, x, opts) : x;
        var pkgfile = path.join(pkgDir, '/package.json');
        if (isFile(pkgfile)) {
            try {
                var pkg = readPackageSync(readFileSync, pkgfile);
            } catch (e) {}

            if (pkg && opts.packageFilter) {
                pkg = opts.packageFilter(pkg, pkgfile, x);
            }

            if (category !== 'pre-exports' && pkg && 'exports' in pkg) {
                if (typeof pkg.exports === 'string' || Array.isArray(pkg.exports)) {
                    if (x !== pkgDir && x !== pkgDir + path.sep) { // not `.`
                    // TODO: ensure coverage
                        console.error('****', x, pkgDir);
                        return;
                    }
                    // TODO: ensure coverage
                    console.error('*****', x, pkg.exports, resolveExportsItem(pkgDir, pkg.exports, x));
                    var resolved = resolveExportsItem(pkgDir, pkg.exports, x);
                    if (resolved) {
                        return resolved;
                    }
                }

                if (category !== 'broken') {
                    var result = validateExportsObject(pkg.exports);
                    if (result.status && result.status !== 'empty') {
                        var objResolved = resolveExportsItem(pkgDir, pkg.exports, x);
                        if (objResolved) {
                            return objResolved;
                        }

                        if (category === 'experimental') { // object form only supports "default" condition
                        }

                        if (category === 'conditions') { // first unflagged version

                        }

                        if (category === 'broken-dir-slash-conditions') { // but directory exports (ending in ./) are broken in these versions

                        }

                        if (category === 'patterns') { // support for "patterns" was added in these versions, and directory exports (ending in ./) are broken

                        }

                        if (category === 'pattern-trailers') { // support for "pattern trailers" was added

                        }

                        if (category === 'pattern-trailers-no-dir-slash') { // support for directory exports (ending in ./) was removed for these versions (>= 17)

                        }
                    }
                }

                console.error('*&!', path.relative(x, basedir) || '.', pkg.exports);

                var notInExportsError = new Error("Package subpath '" + (path.relative(x, basedir) || '.') + "' is not defined by \"exports\" in '" + pkgfile + '"');
                notInExportsError.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
                notInExportsError.cause = result.problems;
                throw notInExportsError;
            }

            if (pkg && pkg.main) {
                if (typeof pkg.main !== 'string') {
                    var mainError = new TypeError('package “' + pkg.name + '” `main` must be a string');
                    mainError.code = 'INVALID_PACKAGE_MAIN';
                    throw mainError;
                }
                if (pkg.main === '.' || pkg.main === './') {
                    pkg.main = 'index';
                }
                try {
                    var mainPath = path.resolve(x, pkg.main);
                    var m = loadAsFileSync(mainPath);
                    if (m) return m;
                    var n = loadAsDirectorySync(mainPath);
                    if (n) return n;
                    var checkIndex = loadAsFileSync(path.resolve(x, 'index'));
                    if (checkIndex) return checkIndex;
                } catch (e) { }
                var incorrectMainError = new Error("Cannot find module '" + path.resolve(x, pkg.main) + "'. Please verify that the package.json has a valid \"main\" entry");
                incorrectMainError.code = 'INCORRECT_PACKAGE_MAIN';
                throw incorrectMainError;
            }
        }

        return loadAsFileSync(path.join(x, '/index'));
    }

    function loadNodeModulesSync(x, start) {
        var thunk = function () { return getPackageCandidates(x, start, opts); };
        var dirs = packageIterator ? packageIterator(x, start, thunk, opts) : thunk();

        for (var i = 0; i < dirs.length; i++) {
            var dir = dirs[i];
            if (isDirectory(path.dirname(dir))) {
                var m = loadAsFileSync(dir);
                if (m) return m;
                var n = loadAsDirectorySync(dir);
                if (n) return n;
            }
        }
    }
};
