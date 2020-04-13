// #!/usr/bin/env node
/**
   @license Copyright (c) 2016-2020 Yebo Technologies Inc.
   @prettier

   Usage: recache path path:lib path@

   Build a cache based on a file and directory list.
   Each file on the command line is copied along with every file it references in
     the directories listed.  Appending a @ to a directory causes the entire
     directory to be processed.
   The resulting files, other than the anchors, include a hash in the filename.
   This hash is a Merkel Hash of all of the dependent files.

*/
/* jshint debug:true, camelcase:false, maxcomplexity:false */
/* globals */
const crypto = require('crypto');
const cli = require('cli'); // https://www.npmjs.com/package/cli
const {execSync} = require('child_process');
const moment = require('moment');
const tmp = require('tmp');
const process = require('process');
const Path = require('path');
const fs = require('fs-extra');

const pid = process.pid;
var options = cli.parse({
  entries: ['e', 'Defined entry points, e.g.: index.html,tester.html', 'string', ''],
  verbose: ['v', 'Verbose logging', 'boolean', false],
  loops: ['l', 'Verbose circular dependency logging', 'boolean', false],
});
const ignoreCircular = ['index.html', 'lib/app-layout/app-scroll-effects/app-scroll-effects-behavior.html'];

var verbose = options.verbose;
var loops = options.loops;
var entries = options.entries && options.entries.split(',');
entries = entries || ['index.html', 'tester.html'];
console.log(entries);

try {
  cli.enable('help', 'version', 'status', 'glob', 'catchall');
} catch (err) {
  console.error(err);
}
var files = []; // List of all files in mentioned directories
var notfound = {}; // Apparent paths that don't exist.
var ignore = {};
var readFiles = false;
// Start with index.html, only processing referenced files.
var todo = entries;

function hashSync(path) {
  var ret = '0';
  try {
    ret = execSync(`md5sum '${path}'`)
      .toString()
      .substring(0, 6);
  } catch (err) {
    console.error(`md5 ${path}`);
  }
  return ret && (ret === '0' || ret.length === 6) ? ret : null;
}

function hashString(content) {
  var hash = '0';
  if (content) {
    hash = crypto
      .createHash('md5')
      .update(content)
      .digest('hex')
      .substring(0, 6);
  }
  return hash;
}

function hashStringArray(contents) {
  return hashString(contents.join('\n'));
}

// Todo: It would be better to feed this to a cpio subprocess.
// Plus fallback Javascript alternative for Windows.
function cp(from, to) {
  var ret = -1;
  try {
    ret = execSync(`mkdir -p '${Path.dirname(to)}' 2>/dev/null;cp '${from}' '${to}'`).toString();
  } catch (err) {
    console.error(`cp ${from} ${to}: ${err}`);
    ret = -1;
  }
  return ret;
}

// let lcontent = fs.readFileSync(fix.path);
// lhash = `${crypto
//          .createHash('md5')
//          .update(lcontent)
//          .digest('hex')
//          .substring(0, 6)}`;

// Only expect these arguments: fn, done or fn, done, delay.
// If fn() returns 'quiet', keeps waiting but no or less logging.
function whenReadyFn(fn, done, delayp, startp, lastReportp) {
  var quiet = false;
  var now = Date.now();
  var start = startp || now;
  var waited = (now - start) / 1000;
  var lastReport = lastReportp || now;
  if (!quiet && now - start > 3000 && now - lastReport > 3000) {
    lastReport = now;
    console.warn('whenReadyFn still waiting:', (now - start) / 1000, ' seconds for:', fn);
  }
  var fin = fn();
  quiet = fin === 'quiet';
  if (quiet) fin = false;
  if (fin) {
    return done();
  }
  var delay = delayp || 10;
  return setTimeout(() => {
    self.whenReadyFn(fn, done, delay, start, lastReport);
  }, delay);
}

// Try to read file cache to avoid enumerating all files too often.
try {
  const filesdata = fs.readFileSync('recache.file.cache');
  if (filesdata) {
    files = JSON.parse(filesdata) || [];
    if (files.length) readFiles = true;
  }
} catch (err) {
  if (!err.message.startsWith('ENOENT')) console.warn(err);
}
// Load list of files to ignore.  These are often in comments, internal to a bundle file,
// or otherwise not expected to actually exist.
try {
  const data = fs.readFileSync('recache.ignore');
  if (data) {
    ignore = JSON.parse(data) || {};
    console.log(`Ignore list:`, ignore);
  }
} catch (err) {
  if (!err.message.startsWith('ENOENT')) console.warn(err);
}
var rpathcache = {};
var allTodo = {};
// Process argument starting points:
if (!files.length) {
  const items = [];
  try {
    cli.args.forEach(argr => {
      const starIdx = argr.lastIndexOf('@');
      const all = starIdx > -1;
      if (all) {
        argr = argr.slice(0, starIdx);
        allTodo[argr] = true;
      }
      const maps = argr.split(':');
      const arg = maps[0];
      const astat = fs.statSync(arg);
      if (astat) {
        const s = arg.split('/');
        let nrpath = argr;
        while (nrpath.startsWith('../')) {
          nrpath = nrpath.substring(3);
        }
        const rpath = maps.length > 1 ? maps[maps.length - 1] : nrpath;
        s.pop();
        const dir = astat.isFile() ? s.join('/') : arg;
        const entry = {all, dir, path: arg, rpath, map: rpath, children: []};
        console.log(`From: ${argr} -> rpath:${rpath} ${all ? 'all' : ''}`);
        items.push(entry);
      }
    });
  } catch (err) {
    console.error(err);
  }
  // Process all found files, adding new files to the list as they are found.
  for (let x = 0; x < items.length; x++) {
    const entry = items[x];
    const {all, dir, path, rpath, map} = entry;
    let stat;
    const s = path.split('/');
    let last = path;
    if (s && s.length) last = s[s.length - 1];
    if (ignore[path]) console.log(`Ignoring: ${path}`);
    if (!(last === '.git' || last === '.local-chromium') && !ignore[path]) {
      try {
        stat = fs.statSync(path);
      } catch (err) {
        if (verbose) console.log(`stat error: ${path}`);
      }
      if (stat && stat.isFile()) {
        let sext = '';
        const sexty =
          (((sext = '.js') || (sext = '.mjs')) && path.endsWith(sext)) ||
          ((sext = '.html') && path.endsWith(sext)) ||
          ((sext = '.css') && path.endsWith(sext)) ||
          ((sext = '.dae') && path.endsWith(sext)) ||
          ((sext = '.json') && path.endsWith(sext));
        // console.log(`${path}`);
        const ext = rpath.substring(rpath.lastIndexOf('.'));
        const dirname = Path.dirname(rpath);
        const rpathbp = Path.basename(rpath);
        const base = (dirname !== '.' ? `${dirname}/` : '') + rpathbp.substring(0, rpathbp.length - ext.length);
        const rec = {dir, path, rpath, base, ext, map, sexty};
        if (!rpathcache[rpath]) {
          rpathcache[rpath] = true;
          files.push(rec);
        }
        if (files.length < 100 || files.length % 10000 === 0) {
          if (verbose) console.log(`Files: ${files.length} rpath:${rec.rpath} dir:${rec.dir}`);
        }
      } else if (stat && stat.isDirectory() /* && !rpathcache[rpath] */) {
        // console.log(`dir:${path}`);
        try {
          const dfs = fs.readdirSync(path);
          dfs.forEach(df => {
            // console.log(`dir: ${entry.path} push: ${rpath}/${df}`);
            if (df !== 'node_modules' && df !== 'bower_components' && df !== '.git') {
              items.push({
                all,
                dir: `${dir}/${df}`,
                path: `${path}/${df}`,
                rpath: `${rpath}/${df}`,
                map,
                base: `${path}/${df}`,
                ext: '',
              });
              if (all) todo.push(`${rpath}/${df}`);
              if (!df.includes('.')) {
                if (!Array.isArray(entry.children)) {
                  entry.children = [];
                }
                entry.children.push(df);
              }
            }
          });
          // console.log(items);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }
}
if (verbose) console.log(files.length);
// console.log(files);
// If we didn't read the file list, then save it for possible use next time.
if (!readFiles) fs.outputFile('recache.file.cache', JSON.stringify(files, null, 1));

var dstat;
try {
  dstat = fs.statSync('cache');
} catch (err) {}
if (!dstat || !dstat.isDirectory()) fs.mkdirSync('cache');

if (verbose) console.log('Writing files');
var count = 0;
var mfiles = {};
var filenames = [];
var hashcache = {};
var specialHash = {};
var plainhashcache = {};
// Create lookup index that translates from relative path to actual item.
for (let x = 0; x < files.length; x++) {
  const entry = files[x];
  if (!mfiles[entry.rpath]) {
    mfiles[entry.rpath] = entry;
    mfiles[`/${entry.rpath}`] = entry;
    const rpath = entry.rpath;
    if (!filenames[rpath]) {
      // Already saw a priority for this.
      filenames.push(rpath);
    }
  }
}

// Start with index.html, only processing referenced files.  And selected directories.
var inProgress = {};
var pending = {}; // Pending rpath watched -> rpath to update
var invPending = {}; // rpaths to update, for deciding to wait to update
var done = {};
var processFile;

// Process each line, looking for file references to recurse on and update.
var linefn = (line, entry, out, selfReferences) => {
  if (line.includes('sourceMappingURL=')) return '';
  let nline = line;
  let x,
    skip = false;
  let pres;
  for (x = 0; line[x] === ' '; x++);
  if (line[x] === '/' && line[x + 1] === '/') skip = true;
  if (!skip) {
    var pattern = /['"`](async:)?(module:)?(async:)?(css:)?([$][{].*[}])?(= )?([a-zA-Z0-9/\.@% _()+,=\-]{1,}[.][a-zA-Z0-9\- _()]+)[`'"\\]/g;
    var match;
    while ((match = pattern.exec(line)) !== null) {
      const async = match[2];
      const module = match[3];
      const async2 = match[4];
      const css = match[5];
      const eqs = match[6];
      let ms = match[7];
      if (
        match &&
        !ignore[ms] &&
        !ms.startsWith('//') &&
        !ms.startsWith('http://') &&
        !ms.startsWith('https://') &&
        !eqs
      ) {
        const sms = ms;
        let path = entry.base.substring(0, entry.base.lastIndexOf('/'));
        if (ms.startsWith('./')) ms = ms.substring(2);
        while (ms.startsWith('../')) {
          ms = ms.substring(3);
          path = path.substring(0, path.lastIndexOf('/'));
          // console.log(`adjust:${path}/${ms} start:${entry.path}`);
        }
        const apath = `/games/sharedAssets-3js`;
        var fix =
          mfiles[ms] ||
          mfiles[`${path}/${ms}`] ||
          mfiles[`${apath}/${ms}`] ||
          //        mfiles[`${apath}/sound/${ms}`] ||
          mfiles[`${apath}/particles/${ms}`] ||
          mfiles[`${apath}/particles/particles128/${ms}`] ||
          mfiles[`/games/${ms}`] ||
          mfiles[`/games/libs-3js/thrax/${ms}`] ||
          mfiles[`/games/libs-3js/examples/js/${ms}`] ||
          mfiles[`/games/libs-3js/thrax/three86/${ms}`] ||
          mfiles[`/assets/${ms}`];
        if (!fix) {
          var mf = mfiles[apath];
          if (mf)
            for (let cx = 0; !fix && cx < mf.children.length; cx++) {
              const mc = mf.children[cx];
              if (mc) fix = mfiles[`${apath}/${mc}/${ms}`];
            }
        }
        // .js files often have their name as a string which would cause infinite recursion.
        if (fix) {
          if (fix.rpath === entry.rpath) {
            // selfReferences.push(line);
            fix = null;
          }
        }
        if (!fix && ms.includes('/')) {
          var sline = line.substring(0, 100);
          if (verbose)
            console.log(
              `Could not find: ${ms} or ${path}/${ms} base:${entry.base} ms:${sms} in ${entry.path} line:${sline}`,
              JSON.stringify(entry, null, 1).substring(0, 100),
            );
          notfound[`${path}/${ms}`] = true;
        }
        if (fix) {
          // console.log(`fix:`, `"${fix.rpath}"`);
          // Hash, then write file if not seen before.
          let lhash = specialHash[fix.rpath] || hashcache[fix.rpath];
          // if (fix.rpath.includes('mwc-chip-set.js')) debugger;
          if (!lhash) {
            // lhash = hashSync(fix.cpath);
            // hashcache[entry.rpath] = `${lhash}`;
            pres = processFile(fix);
            if (pres === 'pending' ) {
              console.log(`    while:${entry.rpath} circular ref to parent:${fix.rpath}`);
              let ar = pending[fix.rpath];
              if (!ar) pending[fix.rpath] = ar = [];
              ar.push(entry);
              invPending[entry.rpath] = true;
              // Compute the hash of the current file with the plain (unmodified)
              // hash of the circular parent.  This file will get reprocessed later
              // But still retain the same plain hash name even though this reference
              // will point to the actual hash-updated file.
              lhash = plainhashcache[fix.rpath];
            } else
              lhash = specialHash[fix.rpath] || hashcache[fix.rpath];
            if (!lhash && !entries.includes(fix.rpath)) {
              console.error(`hash was not found after processing:${fix.rpath}`);
            }
          }
          if (lhash) {
            // Could be an apparent loop, but which may not be. i.e. tester.html
            let hpath = `${fix.base}_${lhash}__${fix.ext}`;
            if (entries.includes(fix.rpath)) hpath = `${fix.base}${fix.ext}`;
            fix.hash = lhash;
            fix.hpath = hpath;
            const slash = fix.hpath[0] === '/' ? '' : '/';
            const saveLastIndex = pattern.lastIndex;
            nline = nline.replace(sms, `${slash}${fix.hpath}`);
            pattern.lastIndex = saveLastIndex;
            if (verbose) console.log(`${entry.rpath}: ${line.substring(0, 60)} -> ${nline.substring(0, 60)}`);
            if (!done[fix.rpath] && pres !== 'pending' && !invPending[fix.rpath] &&
                !entries.includes(fix.rpath)) {
              // console.log(`${entry.rpath}: todo: ${fix.rpath}`);
              // todo.push(`${fix.rpath}`);
              console.error(`${fix.rpath} should be done but is not.`);
            }
          }
        }
      }
    }
  }
  out.push(nline);
  return pres; // pending?
};

function timestampNow() {
  return moment.utc().format('YYYYMMDDTHHmmss.SSS');
}

var timeNow;

function processFile(entry, pendingOk) {
  // Handle circular JS references:
  // In deeper file, compute hash of already in-progress file without include
  //   path hash updates to generate hash of deeper file.
  // Put file on a pending list for the in-progress file.
  // When in-progress file is completed and hash is computed, updaate the pending
  //   deeper file with in-progress file resulting filename, but don't update hash further.
  // Double circular references won't work: imports of 2 in-progress parents would fail.
  //   Probably could use same method, but have to manage 2 pending changes.

  // Don't recurse into entry points which are probably not import statements.
  // if (entry.rpath.includes('mwc-chip-set.js')) debugger;
  if (Object.keys(inProgress).length && entries.includes(entry.rpath)) return "entry";
  if (inProgress[entry.rpath] && !pendingOk) {
    let ok = false;
    ok = ignoreCircular.includes(entry.rpath);
    if ((verbose || loops) && !ok) {
      let list = '';
      Object.keys(inProgress).forEach(key => (list += `\n  ${key}`));
      console.warn(`    ${entry.rpath} is already in progress. ${list}`);
    }
    let cpath;
    try {
      let hash = plainhashcache[entry.rpath];
      if (!hash) {
        hash = hashSync(entry.path);

        plainhashcache[entry.rpath] = hash; // {hash:`${hash}`, entry: entry};
      }
      // cpath = `cache/${entry.base}_${hash}__${entry.ext}`;
    } catch (err) {}
    return 'pending';
  }
  if (done[entry.rpath]) {
    if (verbose) console.warn(`${entry.rpath} is already done.`);
    return 'done';
  }
  inProgress[entry.rpath] = true;
  if (entry.sexty && fs.statSync(entry.path).size < 1024 * 1024 * 5) {
    let rcontent;
    try {
      rcontent = fs.readFileSync(entry.path);
    } catch (err) {
      console.log(err);
    }
    if (rcontent) {
      // const hash = hashSync(entry.cpath);
      // hashcache[entry.rpath] = `${hash}`;
      const content = rcontent.toString().split('\n');
      const out = [];
      if ((entry.path.endsWith('.html') || entry.path.endsWith('.css')))
        out.push(`<!-- Updated: ${timeNow} -->`);
      if ((entry.path.endsWith('.js') || entry.path.endsWith('.js')) &&
          (content[0].length < 1 || content[0][0] !== '{'))
        out.push(`// Updated: ${timeNow}`);
      let comeBackLater = false;
      try {
        for (let y = 0; y < content.length; y++) {
          if (linefn(content[y], entry, out) === 'pending')
            comeBackLater = true;
        }
      } catch (err) {
        console.log(err);
      }
      var output = out.join('\n');
      var hash;
      if (comeBackLater) { // This file is on pending list now.
        specialHash[entry.rpath] = hashString(output);
      } else if (pendingOk) { // We're doing pending update.
        hash = specialHash[entry.rpath];
        hashcache[entry.rpath] = hash;
      } else {
        hash = specialHash[entry.rpath] || hashString(output);
        hashcache[entry.rpath] = hash;
      }
      if (!comeBackLater) {
        let cpath = `cache/${entry.base}_${hash}__${entry.ext}`;
        const cpathtmp = `cache/${entry.base}_${hash}__${entry.ext}.${pid}`;
        if (entries.includes(entry.rpath)) cpath = `cache/${entry.base}${entry.ext}`;
        let ostat;
        try {
          ostat = !entries.includes(entry.rpath) && fs.statSync(cpath);
        } catch (err) {}
        try {
          if (!(ostat && ostat.isFile())) {
            if (verbose) console.log('Writing:', cpath);
            fs.outputFileSync(cpathtmp, output, err => err && console.error(err));
            try {
              fs.unlinkSync(cpath);
            } catch (err) {}
            fs.renameSync(cpathtmp, cpath);
            /*
              try {
              ret = execSync(`mv '${cpathtmp}' '${cpath}'`).toString();
              } catch (err) {
              console.error(`mv ${cpathtmp} ${cpath}: ${err}`);
              ret = -1;
              }
            */
          }
          done[entry.rpath] = true;
        } catch (err) {
          console.error(err);
        }
      }
    }
  } else {
    let cpath;
    try {
      let hash = hashcache[entry.rpath];
      if (!hash) {
        hash = hashSync(entry.path);
        hashcache[entry.rpath] = `${hash}`;
      }
      cpath = `cache/${entry.base}_${hash}__${entry.ext}`;
    } catch (err) {}
    try {
      let ostat;
      try {
        ostat = fs.statSync(cpath);
      } catch (err) {
        if (!err.message.startsWith('ENOENT')) console.warn(err);
      }
      if (!(ostat && ostat.isFile())) {
        if (verbose) console.log('Copying:', entry.rpath, cpath);
        cp(entry.path, cpath);
      }
    } catch (err) {
      console.error(err);
    }
    done[entry.rpath] = true;
  }
  delete inProgress[entry.rpath];
  const pentry = pending[entry.rpath];
  if (pentry) {
    while (pentry.length) {
      const ent = pentry.shift();
      console.log(`    pending: Processing ${ent.rpath}`);
      delete inProgress[ent.rpath];
      delete invPending[ent.rpath];
      delete done[ent.rpath];
      processFile(ent, true);
    }
  }
  delete pending[entry.rpath];
  return 'processed';
}

timeNow = timestampNow();

for (let x = 0; x < todo.length; x++) {
  const tod = todo[x];
  const entry = mfiles[tod];
  if (entry) {
    processFile(entry);
  }
}

fs.outputFile('recache.notfound', JSON.stringify(notfound, null, 1));

/*
function buildSearch(substrings) {
  if (verbose) console.log('buildSearch');
  var res = `${substrings.map(s => s.replace(/[.*+?^${}()|\\]/g, '\\$&')).join('{1,}|')}{1,}`;
  if (verbose) console.log(`buildSearch ${res}`);
  return new RegExp(res);
}
*/
/*
files.forEach(entry => {
  var path = entry.path;
  var rpath = entry.rpath;
  var base = entry.base;
  var ext = entry.ext;
  var map = entry.map;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch (err) { console.log(err); }
  if (content) {
    var hash = crypto.createHash('md5').update(content).digest("hex").substring(0,6);
    var cpath = `cache/${map}/${base}_${hash}${ext}`;
    fs.outputFile(cpath, content, err => err && console.error(err));
    if (count % 1000 === 0) {
      console.log(`write count:${count}`);
      console.log(cpath);
    }
    count++;
  }
});
*/

/*
cli.withStdinLines(function(lines, newline) {
  var totals = {}, btot = 0, out = [], line, date, desc, amtraw, acct, cat, notes, maxCat = 0;
  for (linen in lines) {
    if (!(line = lines[linen]).length) continue;
    if (/\/.*\/20[1-2][0-9],.*,.*,.*,/.test(line)) {
      [date,acct,cat,amtraw,subcat,desc,notes] = line.split(',');
      amt = 1*amtraw;
      if (isNaN(amt)) throw new Error("Bad amt:"+line);
      if (cat !== 'tax') btot += cat === 'irent' ? -amt : amt;
      totals[cat] = amt + fixNumber(totals[cat],0);
      maxCat = Math.max(maxCat, cat.length);
      if (cat !== subcat) {
        let scat = cat+'_'+subcat;
        totals[scat] = amt + fixNumber(totals[scat],0);
        maxCat = Math.max(maxCat, scat.length);
      }
    } else console.log(line);
  }
  Object.getOwnPropertyNames(totals).forEach(function(val, idx, array) {
    out.push(val.padEnd(maxCat, ' ') +' '+ Math.round(totals[val]));  });
  for (line in out.sort()) console.log(out[line]);
  console.log("================\nTotal: "+Math.round(btot));
});
*/

var isNumber = function(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
};
var fixNumber = function(n, m) {
  if (!isNumber(n)) return m;
  return n;
};
var notEmpty = function(s) {
  return typeof s === 'string' && s.length > 0;
};

/*
program
  .arguments('<file> <skip>')
  .option('-s, --skip <num>', 'How many lines to skip')
  .action(function(file,skip) {
    console.log('file:%s skip:%s', file,skip);
  })
  .parse(process.argv);
*/
// var spattern = /['"](([a-zA-Z0-9\-. _()]{0,}\/{1,}){1,}[a-zA-Z0-9\-. _()]{1,}[.][a-zA-Z0-9\- _()]{1,})['"]/;
