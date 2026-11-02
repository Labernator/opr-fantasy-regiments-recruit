#!/usr/bin/env node
'use strict';
/**
 * compare-units.js
 *
 * Compares the units of two catalogues (e.g. your hand-made DarkElves.json and the
 * one made by generate-units.js) and prints what differs. Ids, sort order and
 * cosmetic flags are ignored, so only real differences show up.
 *
 * Usage:
 *   node compare-units.js
 *        asks for the two catalogues (and optionally one unit).
 *
 *   node compare-units.js <hand-made.json> <generated.json> [--unit "Hydra"] [--context 1]
 *
 *   -  only in the first file (hand-made)
 *   +  only in the second file (generated)
 *
 * Cost modifiers are shown as the price they produce ("@6 Snake Sisters=150"), so a
 * "set 150" and a "multiply by 2" that give the same price count as equal.
 */
const fs = require('fs');

const path = require('path');
const { collectInputs } = require('./cli-prompt');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const SPEC = {
  script: 'compare-units.js',
  inputs: [
    {
      key: 'first', flag: '--first', positional: true, type: 'file', accept: ['catalogue'], required: true,
      label: 'First catalogue (your hand-made one)',
      help: 'The catalogue to compare against, e.g. your hand-made DarkElves.json.',
      suggest: (found) => found.filter((f) => f.kind === 'catalogue'),
    },
    {
      key: 'second', flag: '--second', positional: true, type: 'file', accept: ['catalogue'], required: true,
      label: 'Second catalogue (the generated one)',
      help: 'The catalogue made by generate-units.js.',
      preferResults: true,
      suggest: (found, v) => found.filter((f) => f.kind === 'catalogue' && f.file !== v.first),
    },
    {
      key: 'unit', flag: '--unit', type: 'text', required: false,
      label: 'Only this unit? (a name, Enter = all units)',
      default: () => '',
    },
  ],
};
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).catalogue;

async function main() {
const inputs = await collectInputs(SPEC);
const fileA = inputs.first, fileB = inputs.second;
const only = inputs.unit;
const context = Number(opt('--context', 1));
const A = load(fileA);
const B = load(fileB);

const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const units = (c) => new Map((c.sharedSelectionEntries || []).filter((e) => e.type === 'unit').map((e) => [clean(e.name).toLowerCase(), e]));

// ------------------------------------------------------------ outline
function fieldName(f, ctx) {
  if (f === 'selections' || f === 'hidden') return f;
  if (f.startsWith('limit::')) return 'limit%' + fieldName(f.slice(7), ctx);
  return ctx.costNames[f] || f.slice(0, 6);
}
function consText(c, ctx) {
  const flags = [c.percentValue ? '%' : '', c.includeChildSelections ? 'children' : '', c.includeChildForces ? 'forces' : ''].filter(Boolean).join('+');
  return `${c.type} ${c.value} ${fieldName(c.field, ctx)} in ${c.scope === ctx.unitId ? 'unit' : c.scope}${flags ? ' (' + flags + ')' : ''}`;
}
/** price a node gets for a cost modifier, or the modifier as text */
function modText(m, node, ctx) {
  const base = (node.costs || []).find((c) => ctx.costNames[c.typeId] === 'pts');
  const cond = (m.conditions || []).map((c) => {
    const child = c.childId ? ctx.idNames[c.childId] || '?' : '';
    return `${c.type} ${c.value} ${fieldName(c.field || '', ctx)}${child ? ' ' + child : ''}${c.scope === ctx.unitId ? '' : ' in ' + c.scope}${c.percentValue ? ' %' : ''}`;
  });
  const when = cond.length ? ` when ${cond.join(' & ')}` : '';
  if (ctx.costNames[m.field] === 'pts' && base && /multiply|set/.test(m.type)) {
    const price = m.type === 'set' ? m.value : base.value * m.value;
    return `price ${price}${when}`;
  }
  return `${m.type} ${fieldName(m.field, ctx)} ${m.value}${when}`;
}
function line(kind, o, ctx) {
  const parts = [`${kind} ${clean(o.name)}`];
  if (o.type && kind !== 'group') parts.push(`(${o.type})`);
  if (o.costs && o.costs.length) parts.push('cost ' + o.costs.map((c) => `${c.name}=${c.value}`).join(','));
  if (o.constraints && o.constraints.length) parts.push('| ' + o.constraints.map((c) => consText(c, ctx)).sort().join('; '));
  if (o.modifiers && o.modifiers.length) parts.push('| ' + o.modifiers.map((m) => modText(m, o, ctx)).sort().join('; '));
  return parts.join(' ');
}
const KIDS = [
  ['categoryLinks', 'cat'], ['infoGroups', 'rules'], ['infoLinks', 'info'], ['profiles', 'profile'],
  ['selectionEntries', 'entry'], ['entryLinks', 'link'], ['selectionEntryGroups', 'group'],
];
function tree(o, kind, ctx, depth = 0, out = []) {
  if (kind === 'cat') { out.push({ d: depth, t: `cat ${clean(o.name)}${o.primary ? ' (primary)' : ''}` }); return out; }
  if (kind === 'info') { out.push({ d: depth, t: `info ${clean(o.name)}` }); return out; }
  if (kind === 'profile') {
    out.push({ d: depth, t: `profile ${o.typeName} ${clean(o.name)} ${o.characteristics.map((c) => `${c.name}=${clean(c.$text)}`).join(' ')}` });
    return out;
  }
  if (kind === 'rules') {
    out.push({ d: depth, t: `rules ${clean(o.name)}: ${(o.infoLinks || []).map((l) => clean(l.name)).sort().join(', ')}` });
    return out;
  }
  const self = { d: depth, t: line(kind, o, ctx), kids: [] };
  const kids = [];
  for (const [key, k] of KIDS) for (const c of o[key] || []) kids.push(tree(c, k, ctx, depth + 1, []));
  kids.sort((a, b) => a[0].t.localeCompare(b[0].t));
  out.push(self, ...kids.flat());
  return out;
}
function outline(unit) {
  const idNames = {};
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.id && o.name) idNames[o.id] = clean(o.name);
      Object.values(o).forEach(walk);
    }
  })(unit);
  const costNames = {};
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (Array.isArray(o.costs)) o.costs.forEach((c) => (costNames[c.typeId] = c.name));
      Object.values(o).forEach(walk);
    }
  })(unit);
  const ctx = { idNames, costNames, unitId: unit.id };
  return tree(unit, 'unit', ctx).map((l) => '  '.repeat(l.d) + l.t);
}

// --------------------------------------------------------------- diff
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}
function printDiff(d) {
  const show = new Set();
  d.forEach(([c], i) => { if (c !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) show.add(k); });
  let last = -2;
  d.forEach(([c, text], i) => {
    if (!show.has(i)) return;
    if (i > last + 1) console.log('    ...');
    console.log(`    ${c} ${text}`);
    last = i;
  });
}

// --------------------------------------------------------------- main
const ua = units(A), ub = units(B);
let same = 0, differ = 0;
const names = [...new Set([...ua.keys(), ...ub.keys()])].filter((n) => !only || n === only.toLowerCase());
for (const n of names) {
  const a = ua.get(n), b = ub.get(n);
  if (!a || !b) { console.log(`\n${(a || b).name}: only in ${a ? 'the first' : 'the second'} file`); differ++; continue; }
  const d = lcsDiff(outline(a), outline(b));
  if (d.every(([c]) => c === ' ')) { same++; console.log(`\n${a.name}: identical`); continue; }
  differ++;
  console.log(`\n${a.name}: ${d.filter(([c]) => c === '-').length} only in first (-), ${d.filter(([c]) => c === '+').length} only in second (+)`);
  printDiff(d);
}
console.log(`\n${same} identical, ${differ} with differences (of ${names.length} units)`);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
