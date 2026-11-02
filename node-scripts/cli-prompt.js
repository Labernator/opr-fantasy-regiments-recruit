'use strict';
/**
 * cli-prompt.js
 *
 * Shared input handling for extract-weapons.js and generate-units.js.
 *
 *  - Every input can still be given as a command-line flag (scripts keep working).
 *  - Inputs that are missing are asked for interactively. Required ones always,
 *    optional ones as soon as the script is in interactive mode.
 *  - File answers can be typed, dragged into the terminal (quotes are removed),
 *    given as a number from the list of suggestions, or accepted with Enter.
 *  - Every file is checked: it must exist and be the right kind of JSON, so a
 *    wrong file is caught here and not halfway through the run.
 *
 * Flags understood by every script: --no-prompt (never ask, fail instead),
 * --interactive (ask for optional inputs too), --yes (skip the final question).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ------------------------------------------------------------ file kinds
/** What kind of JSON is this? Used to validate and to suggest files. */
function classify(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.gameSystem) return { kind: 'system', name: json.gameSystem.name };
  if (json.catalogue) return { kind: json.catalogue.library ? 'library' : 'catalogue', name: json.catalogue.name };
  if (Array.isArray(json.units)) return { kind: 'api', name: json.name };
  const list = Array.isArray(json) ? json : json.rules || json.sharedProfiles;
  if (Array.isArray(list) && list.length && list[0] && list[0].name && list[0].description) return { kind: 'rules-json' };
  return null;
}
const KIND_TEXT = {
  api: 'an OPR army API file (JSON with a "units" list)',
  system: 'a game system file (JSON with "gameSystem")',
  catalogue: 'an army catalogue (JSON with "catalogue", not a library)',
  library: 'a library catalogue (JSON with "catalogue")',
  'rules-json': 'an API rules file (a list of rules with name and description)',
};

const jsonCache = new Map();
function readKind(file) {
  if (jsonCache.has(file)) return jsonCache.get(file);
  let res;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    res = { ok: true, info: classify(json), json };
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  jsonCache.set(file, res);
  return res;
}

/** .json files in the working directory with their kind, for suggestions. */
function scanFolder(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!/\.json$/i.test(n)) continue;
    const file = path.join(dir, n);
    try { if (!fs.statSync(file).isFile() || fs.statSync(file).size > 50e6) continue; } catch (e) { continue; }
    const r = readKind(file);
    if (r.ok && r.info) out.push({ file, fileName: n, kind: r.info.kind, title: r.info.name });
  }
  return out;
}

/** "C:\x y\file.json", 'file.json', ~/file.json, drag-and-dropped paths ... */
function cleanPath(s) {
  let p = String(s).trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  if (process.platform !== 'win32') p = p.replace(/\\ /g, ' ');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function checkFile(file, accept) {
  if (!fs.existsSync(file)) return `File not found: ${file}`;
  if (!fs.statSync(file).isFile()) return `Not a file: ${file}`;
  const r = readKind(file);
  if (!r.ok) return `Not valid JSON (${r.error})`;
  if (!r.info || !accept.includes(r.info.kind)) {
    const got = r.info ? `a ${r.info.kind} file` : 'some other JSON';
    return `That is ${got}, but ${accept.map((k) => KIND_TEXT[k]).join(' or ')} is needed.`;
  }
  return null;
}

// ----------------------------------------------------------- line reader
function lineReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = [];
  let waiter = null;
  let closed = false;
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  const interactive = Boolean(process.stdin.isTTY);
  return {
    async ask(question) {
      process.stdout.write(question);
      const line = queue.length ? queue.shift() : closed ? null : await new Promise((r) => { waiter = r; });
      if (line === null) { console.log('\nInput ended, nothing was run.'); process.exit(1); }
      if (!interactive) console.log(line); // show piped answers in the log
      return line;
    },
    close() { rl.close(); },
  };
}

// ---------------------------------------------------------------- main
/**
 * spec = {
 *   script: 'generate-units.js',
 *   inputs: [{
 *     key, flag, label,
 *     type: 'file' | 'text',
 *     accept: ['api'],              // file kinds that are fine
 *     required: true|false,
 *     positional: true,             // the first bare argument means this input
 *     suggest: (found, values) => [files],  // ordered suggestions; first is the default
 *     default: (values) => 'text',  // for text inputs and the output file
 *     help: 'one line shown above the question',
 *     output: true,                 // an output file: asks before overwriting, never an input file
 *   }]
 * }
 * Resolves to { key: absolute path | text | undefined }.
 */
async function collectInputs(spec, argv = process.argv.slice(2)) {
  // ---- parse the command line
  const flags = {};
  const bools = new Set(['--no-prompt', '--interactive', '--yes', '--help', '-h']);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bools.has(a)) flags[a] = true;
    else if (a.startsWith('--')) { flags[a] = argv[i + 1]; i++; }
    else positional.push(a);
  }
  const given = {};
  for (const inp of spec.inputs) {
    let v = flags[inp.flag];
    if (v === undefined && inp.positional && positional.length) v = positional.shift();
    if (v !== undefined) given[inp.key] = v;
  }

  if (flags['--help'] || flags['-h']) {
    console.log(`Usage: node ${spec.script} [options]\n\nRun it without options and it asks for everything.\n`);
    for (const inp of spec.inputs) console.log(`  ${inp.flag.padEnd(12)} ${inp.label}${inp.required || /optional|\?|Enter/i.test(inp.label) || inp.output ? '' : ' (optional)'}`);
    console.log('\n  --no-prompt  never ask, fail when a required input is missing\n  --interactive  also ask for optional inputs\n  --yes        do not ask for confirmation');
    process.exit(0);
  }

  const missingRequired = spec.inputs.filter((i) => i.required && given[i.key] === undefined);
  const interactive = missingRequired.length > 0 || Boolean(flags['--interactive']);
  if (interactive && flags['--no-prompt']) {
    console.error(`Missing: ${missingRequired.map((i) => i.flag).join(', ')}\nRun "node ${spec.script} --help" for the options.`);
    process.exit(1);
  }

  const reader = interactive ? lineReader() : null;
  const folder = scanFolder(process.cwd());
  const values = {};
  const fail = (msg) => { console.error(`\n${msg}`); if (reader) reader.close(); process.exit(1); };

  if (interactive) {
    console.log(`\n${spec.script}: I will ask for what is missing.`);
    console.log('Enter = take the suggestion in [brackets]   - = leave an optional input out   Ctrl+C = cancel\n');
  }

  for (const inp of spec.inputs) {
    const label = inp.label;
    // ---- given on the command line: only check it
    if (given[inp.key] !== undefined) {
      if (inp.type === 'text') { values[inp.key] = given[inp.key]; continue; }
      if (given[inp.key] === '-') { values[inp.key] = undefined; continue; }
      const file = inp.output ? path.resolve(given[inp.key]) : cleanPath(given[inp.key]);
      if (!inp.output) {
        const err = checkFile(file, inp.accept);
        if (err) fail(`${inp.flag}: ${err}`);
      }
      values[inp.key] = file;
      if (interactive) console.log(`  ${label}: ${path.relative(process.cwd(), file) || file}`);
      continue;
    }
    // ---- optional inputs are only asked in interactive mode
    if (!inp.required && !interactive) {
      if (inp.output) values[inp.key] = path.resolve(inp.default(values));
      else if (inp.type === 'text') values[inp.key] = inp.default ? inp.default(values) || undefined : undefined;
      continue;
    }

    // ---- ask
    if (inp.help) console.log(inp.help);
    if (inp.type === 'text') {
      const def = inp.default ? inp.default(values) : '';
      const ans = (await reader.ask(`${label}${def ? ` [${def}]` : ''}: `)).trim();
      values[inp.key] = ans === '' ? def || undefined : ans === '-' ? undefined : ans;
      console.log('');
      continue;
    }
    if (inp.output) {
      const def = path.relative(process.cwd(), path.resolve(inp.default(values))) || inp.default(values);
      for (;;) {
        const ans = (await reader.ask(`${label} [${def}]: `)).trim();
        const file = ans === '' ? path.resolve(def) : cleanPath(ans);
        const inputs = Object.values(values).filter((v) => typeof v === 'string');
        if (inputs.includes(file)) { console.log('  That is one of the input files, it would be overwritten. Please choose another name.'); continue; }
        if (fs.existsSync(file)) {
          const yn = (await reader.ask(`  ${path.basename(file)} already exists. Overwrite? [y/N]: `)).trim().toLowerCase();
          if (yn !== 'y' && yn !== 'yes') continue;
        }
        values[inp.key] = file;
        break;
      }
      console.log('');
      continue;
    }
    // files
    const isResult = (f) => /\.generated\./i.test(f.fileName);
    const found = (inp.suggest ? inp.suggest(folder, values).filter(Boolean) : folder.filter((f) => inp.accept.includes(f.kind)))
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (inp.preferResults ? 0 : Number(isResult(a.f)) - Number(isResult(b.f))) || a.i - b.i)
      .map((x) => x.f);
    const list = found.slice(0, 9);
    if (list.length) {
      console.log('  Found here:');
      list.forEach((f, i) => console.log(`   ${i + 1}) ${f.fileName}  (${f.kind}${f.title ? ': ' + f.title : ''})`));
    }
    const def = list[0];
    for (;;) {
      const hint = [def ? `Enter = ${def.fileName}` : null, !inp.required ? '- = none' : null].filter(Boolean).join(', ');
      const ans = (await reader.ask(`${label}${hint ? ` [${hint}]` : ''}: `)).trim();
      let file;
      if (ans === '') {
        if (def) file = def.file;
        else if (!inp.required) { values[inp.key] = undefined; break; }
        else { console.log('  This one is required.'); continue; }
      } else if (ans === '-' && !inp.required) { values[inp.key] = undefined; break; }
      else if (/^\d+$/.test(ans) && list[Number(ans) - 1]) file = list[Number(ans) - 1].file;
      else file = cleanPath(ans);
      const err = checkFile(file, inp.accept);
      if (err) { console.log(`  ${err}`); continue; }
      values[inp.key] = file;
      break;
    }
    console.log('');
  }

  // ---- summary and confirmation
  if (interactive) {
    console.log('Settings:');
    for (const inp of spec.inputs) {
      const v = values[inp.key];
      console.log(`  ${inp.label}: ${v === undefined ? '-' : typeof v === 'string' && path.isAbsolute(v) ? path.relative(process.cwd(), v) || v : v}`);
    }
    const cmd = [`node ${spec.script}`];
    for (const inp of spec.inputs) {
      const v = values[inp.key];
      if (v === undefined) continue;
      const shown = path.isAbsolute(v) ? path.relative(process.cwd(), v) || v : v;
      cmd.push(inp.positional ? `"${shown}"` : `${inp.flag} "${shown}"`);
    }
    console.log(`\nTo run it again without questions:\n  ${cmd.join(' ')}\n`);
    if (!flags['--yes']) {
      for (;;) {
        const yn = (await reader.ask('Run now? [Y/n]: ')).trim().toLowerCase();
        if (yn === '' || yn === 'y' || yn === 'yes') break;
        if (yn === 'n' || yn === 'no') { reader.close(); console.log('Cancelled.'); process.exit(0); }
        console.log('  Please answer y or n.');
      }
    }
    reader.close();
    console.log('');
  }
  return values;
}

/** Parsed JSON of a file the user picked (cached), e.g. to read the army name. */
function peek(file) {
  const r = file ? readKind(file) : null;
  return r && r.ok ? r.json : null;
}

module.exports = { collectInputs, peek };
