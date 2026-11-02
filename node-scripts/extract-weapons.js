#!/usr/bin/env node
'use strict';
/**
 * extract-weapons.js
 *
 * Step 1 of the OPR -> New Recruit generator: collects every weapon of an
 * army from the OPR API JSON and writes them into a Weapons library catalogue.
 *
 * Usage:
 *   node extract-weapons.js
 *        asks for every file (API, current Weapons library, game system, rules,
 *        output). Press Enter to accept a suggestion.
 *
 *   node extract-weapons.js <army-api.json> [--existing Weapons.json]
 *                                           [--system opr-recruit.json]
 *                                           [--rules Rules.json]
 *                                           [--out Weapons.generated.json]
 *        runs without questions when the API file is given.
 *        --interactive also asks for the optional files, --no-prompt never asks.
 *
 *   --existing  Your current Weapons.json. Its entries are kept untouched
 *               (ids stay valid), only missing weapons are added.
 *   --system    Your game system file. Used for weapon profile/characteristic ids.
 *   --rules     Rules.json (API rule definitions; used for descriptions of
 *               weapon-rule profiles that do not already exist).
 *   --out       Output file (default: Weapons.generated.json). Input files are
 *               never modified.
 *
 * Re-running with the output as --existing adds nothing (idempotent).
 */
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------- INPUTS
// Every input can be given as a flag; whatever is missing is asked for (see cli-prompt.js).
const path = require('path');
const { collectInputs } = require('./cli-prompt');
const unused = (v, f) => !Object.values(v).includes(f.file);
const SPEC = {
  script: 'extract-weapons.js',
  inputs: [
    {
      key: 'api', flag: '--api', positional: true, type: 'file', accept: ['api'], required: true,
      label: 'OPR army API file',
      help: 'The army JSON from the OPR API (the file with "units", "upgradePackages", ...).',
      suggest: (found) => found.filter((f) => f.kind === 'api'),
    },
    {
      key: 'existing', flag: '--existing', type: 'file', accept: ['library', 'catalogue'], required: false,
      label: 'Your current Weapons library (optional, e.g. Weapons.json)',
      help: 'Its entries stay untouched, only missing weapons are added. Without it a new library is made.',
      suggest: (found, v) => found.filter((f) => /weapon/i.test(f.title || '') && unused(v, f)),
    },
    {
      key: 'system', flag: '--system', type: 'file', accept: ['system'], required: false,
      label: 'Game system file (optional, e.g. opr-recruit.json)',
      help: 'Used for the weapon profile ids. Recommended.',
      suggest: (found) => found.filter((f) => f.kind === 'system'),
    },
    {
      key: 'rules', flag: '--rules', type: 'file', accept: ['rules-json'], required: false,
      label: 'API rules file (optional, e.g. Rules.json)',
      help: 'Rule descriptions, used for weapon rules that do not have a profile yet.',
      suggest: (found, v) => found.filter((f) => f.kind === 'rules-json' && unused(v, f)),
    },
    {
      key: 'out', flag: '--out', type: 'file', output: true, required: false,
      label: 'Output file',
      help: 'Where the result is written. The input files are never changed.',
      default: (v) => path.join(v.existing ? path.dirname(v.existing) : process.cwd(), 'Weapons.generated.json'),
    },
  ],
};

async function main() {
const inputs = await collectInputs(SPEC);
const apiPath = inputs.api;
const outPath = inputs.out;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const api = readJson(apiPath);
const existingFile = inputs.existing ? readJson(inputs.existing) : null;
const systemFile = inputs.system ? readJson(inputs.system).gameSystem : null;
const rulesFile = inputs.rules ? readJson(inputs.rules) : [];
const rulesSource = Array.isArray(rulesFile) ? rulesFile : (rulesFile.rules || rulesFile.sharedProfiles || []);

// ------------------------------------------------- ids and type constants
// Fallbacks are the ids from your current game system. If --system is given
// they are looked up by name instead.
const T = {
  weapon: '6c87-d500-88a9-391e',
  rng: 'fab9-2a51-bdac-23c6',
  atk: '75d2-2272-05fb-9ced',
  ap: '0a60-e782-a04a-e6ce',
  specialRules: '56a2-97e0-9760-25b7',
};
if (systemFile) {
  const wt = (systemFile.profileTypes || []).find((p) => p.name === 'Weapon');
  if (wt) {
    T.weapon = wt.id;
    const ch = (n) => (wt.characteristicTypes.find((c) => c.name === n) || {}).id;
    T.rng = ch('Rng') || T.rng;
    T.atk = ch('ATK') || T.atk;
    T.ap = ch('AP') || T.ap;
    T.specialRules = ch('Special Rules') || T.specialRules;
  }
}

const usedIds = new Set();
(function collectIds(o) {
  if (Array.isArray(o)) return o.forEach(collectIds);
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'id' && typeof v === 'string') usedIds.add(v);
      else collectIds(v);
    }
  }
})([existingFile, systemFile]);

/** Deterministic id in the 4x4 hex format, so re-runs give the same ids. */
function makeId(key) {
  for (let n = 0; ; n++) {
    const h = crypto.createHash('sha1').update(n ? `${key}#${n}` : key).digest('hex').slice(0, 16);
    const id = h.match(/.{4}/g).join('-');
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

// ------------------------------------------------------------ helpers
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const ruleLabel = (r) => (r.rating != null ? `${r.name}(${r.rating})` : r.name);

function buildLabel(w) {
  if (w.label) return w.label;
  const rules = (w.specialRules || []).slice().sort((a, b) => {
    if (a.name === 'AP') return -1;
    if (b.name === 'AP') return 1;
    return ruleLabel(a).localeCompare(ruleLabel(b));
  });
  const parts = [];
  if (w.range > 0) parts.push(`${w.range}"`);
  parts.push(`A${w.attacks}`);
  rules.forEach((r) => parts.push(ruleLabel(r)));
  return `${w.name} (${parts.join(', ')})`;
}

function toWeapon(w, source) {
  const ap = (w.specialRules || []).find((r) => r.name === 'AP');
  return {
    label: buildLabel(w),
    name: w.name,
    rng: w.range > 0 ? `${w.range}"` : '-',
    atk: String(w.attacks),
    ap: ap && ap.rating != null ? String(ap.rating) : '-',
    rules: (w.specialRules || [])
      .filter((r) => r.name !== 'AP')
      .map((r) => ({ name: r.name, rating: r.rating })),
    sources: new Set([source]),
  };
}

// ------------------------------------------- 1. collect weapons from API
const weapons = new Map(); // label -> weapon
function addWeapon(w, source) {
  const cand = toWeapon(w, source);
  const prev = weapons.get(cand.label);
  if (prev) prev.sources.add(source);
  else weapons.set(cand.label, cand);
}

for (const u of api.units || []) {
  (u.weapons || []).forEach((w) => addWeapon(w, `unit: ${u.name}`));
  for (const item of u.items || [])
    (item.content || []).filter((c) => c.type === 'ArmyBookWeapon').forEach((w) => addWeapon(w, `unit item: ${u.name}`));
}
for (const pkg of api.upgradePackages || []) {
  for (const section of pkg.sections || []) {
    for (const option of section.options || []) {
      for (const gain of option.gains || []) {
        const src = `upgrade: ${pkg.hint} / ${option.label}`;
        if (gain.type === 'ArmyBookWeapon') addWeapon(gain, src);
        for (const c of gain.content || []) if (c.type === 'ArmyBookWeapon') addWeapon(c, src);
      }
    }
  }
}

// --------------------------------- 2. weapon-rule profile lookup
// Weapon rules belong in Weapons.json's own sharedProfiles collection, not
// gameSystem.sharedProfiles (which contains general game-system rules).
const existingCatalogue = existingFile ? existingFile.catalogue : {};
const ruleProfiles = existingCatalogue.sharedProfiles || [];
const rulesByName = new Map(ruleProfiles.map((p) => [norm(p.name), p]));
const descriptions = new Map();
for (const r of rulesSource) {
  if (r && r.name && r.description) descriptions.set(norm(r.name), r.description);
}
const weaponRuleTypeId = ruleProfiles[0]?.typeId || '16b9-5fbc-9708-1125';
const descriptionTypeId = ruleProfiles[0]?.characteristics?.find((c) => c.name === 'Description')?.typeId || '6fe7-c31b-ee10-2876';

function ruleCandidates(r) {
  const label = ruleLabel(r);
  return r.rating != null
    ? [label, `${r.name} (${r.rating})`, `${r.name}(${r.rating})`, r.name]
    : [r.name];
}
function findRule(r) {
  for (const candidate of ruleCandidates(r)) {
    const found = rulesByName.get(norm(candidate));
    if (found) return found;
  }
  return null;
}
function ensureRule(r) {
  let profile = findRule(r);
  if (profile) return profile;
  // Only create a profile when Rules.json provides an authoritative description.
  const description = descriptions.get(norm(r.name));
  if (!description) return null;
  const name = ruleLabel(r);
  profile = {
    name,
    id: makeId(`weapon-special-rule:${norm(name)}`),
    hidden: false,
    typeId: weaponRuleTypeId,
    typeName: 'Weapon Special Rule',
    characteristics: [{ name: 'Description', '$text': description, typeId: descriptionTypeId }],
  };
  ruleProfiles.push(profile);
  rulesByName.set(norm(name), profile);
  return profile;
}

// ----------------------------- 3. match against the existing library
const existingEntries = existingFile ? existingFile.catalogue.sharedSelectionEntries || [] : [];
const sampleWeaponProfile = existingEntries.flatMap((e) => e.profiles || []).find((p) => p.characteristics?.some((c) => c.name === 'Special Rules'));
if (sampleWeaponProfile) {
  const specialChar = sampleWeaponProfile.characteristics.find((c) => c.name === 'Special Rules');
  T.specialRules = specialChar.typeId || T.specialRules;
}
const entryInfo = (e) => {
  const p = (e.profiles || [])[0];
  const ch = {};
  ((p && p.characteristics) || []).forEach((c) => (ch[c.name] = c.$text));
  const rules = (e.infoLinks || []).map((l) => l.name);
  return { p, rng: ch.Rng, atk: ch.ATK, ap: ch.AP, rules };
};
const sig = (name, rng, atk, ap, rules) =>
  [norm(name), rng, atk, ap, rules.map(norm).sort().join('+')].join('|');

const byName = new Map();
const bySig = new Map();
existingEntries.forEach((e, i) => {
  byName.set(norm(e.name), i);
  const inf = entryInfo(e);
  if (inf.p) bySig.set(sig(inf.p.name, inf.rng, inf.atk, inf.ap, inf.rules), i);
});

const matchedIdx = new Set();
const newEntries = [];
const missingRules = new Map(); // rule label -> weapons using it
const audit = [];
const notes = [];
function desiredRuleLinks(w) {
  const links = [];
  for (const r of w.rules) {
    const profile = ensureRule(r);
    if (profile) {
      links.push({
        name: profile.name,
        id: makeId(`weapon:${norm(w.label)}:link:${norm(profile.name)}`),
        hidden: false,
        targetId: profile.id,
        type: 'profile',
      });
    } else {
      const k = ruleLabel(r);
      if (!missingRules.has(k)) missingRules.set(k, []);
      missingRules.get(k).push(w.label);
    }
  }
  return links;
}
function setWeaponRules(entry, w) {
  const links = desiredRuleLinks(w);
  // Preserve unrelated links; replace only links targeting weapon-rule profiles.
  const ruleIds = new Set(ruleProfiles.map((p) => p.id));
  const unrelated = (entry.infoLinks || []).filter((l) => !ruleIds.has(l.targetId));
  const seen = new Set();
  entry.infoLinks = [...unrelated, ...links.filter((l) => {
    if (seen.has(l.targetId)) return false;
    seen.add(l.targetId);
    return true;
  })];
  if (!entry.infoLinks.length) delete entry.infoLinks;
  const profile = (entry.profiles || [])[0];
  if (profile) {
    profile.characteristics = profile.characteristics || [];
    let characteristic = profile.characteristics.find((c) => c.name === 'Special Rules');
    if (!characteristic) {
      characteristic = { name: 'Special Rules', '$text': '', typeId: T.specialRules };
      profile.characteristics.push(characteristic);
    }
    characteristic.$text = w.rules.map(ruleLabel).join(', ');
    characteristic.typeId = characteristic.typeId || T.specialRules;
  }
}

for (const w of [...weapons.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  let idx = byName.get(norm(w.label));
  let how = 'name';
  if (idx === undefined) {
    idx = bySig.get(sig(w.name, w.rng, w.atk, w.ap, w.rules.map((r) => r.name)));
    how = 'profile';
  }

  if (idx !== undefined && !matchedIdx.has(idx)) {
    matchedIdx.add(idx);
    const e = existingEntries[idx];
    if (how === 'profile') notes.push(`matched by profile: "${w.label}" -> existing "${e.name}"`);
    // audit: stats and rule links of the hand-written entry vs. the API
    const inf = entryInfo(e);
    const diffs = [];
    if (inf.rng !== w.rng) diffs.push(`Rng ${inf.rng} (API ${w.rng})`);
    if (inf.atk !== w.atk) diffs.push(`ATK ${inf.atk} (API ${w.atk})`);
    if (inf.ap !== w.ap) diffs.push(`AP ${inf.ap} (API ${w.ap})`);
    const base = (s) => norm(s).replace(/\s*\(.*\)\s*$/, ''); // "Deadly (3)" -> "deadly"
    const have = inf.rules.map(base).sort().join(', ');
    const want = w.rules.map((r) => base(r.name)).sort().join(', ');
    if (have !== want) diffs.push(`rules [${inf.rules.join(', ')}] (API [${w.rules.map((r) => r.name).join(', ')}])`);
    if (diffs.length) audit.push(`${e.name}: ${diffs.join('; ')}`);
    setWeaponRules(e, w);
    continue;
  }

  // ---- new entry
  const infoLinks = desiredRuleLinks(w);
  const entry = {
    name: w.label,
    id: makeId(`weapon:${norm(w.label)}`),
    hidden: false,
    import: true,
    type: 'upgrade',
    constraints: [
      {
        id: makeId(`weapon:${norm(w.label)}:max`),
        field: 'selections',
        scope: 'parent',
        shared: true,
        type: 'max',
        value: 1,
      },
    ],
  };
  if (infoLinks.length) entry.infoLinks = infoLinks;
  entry.profiles = [
    {
      name: w.name,
      id: makeId(`weapon:${norm(w.label)}:profile`),
      hidden: false,
      typeId: T.weapon,
      typeName: 'Weapon',
      characteristics: [
        { name: 'Rng', $text: w.rng, typeId: T.rng },
        { name: 'ATK', $text: w.atk, typeId: T.atk },
        { name: 'AP', $text: w.ap, typeId: T.ap },
        { name: 'Special Rules', $text: w.rules.map(ruleLabel).join(', '), typeId: T.specialRules },
      ],
    },
  ];
  newEntries.push(entry);
}

// ----------------------------------------------------- 4. write output
const catalogue = existingFile
  ? JSON.parse(JSON.stringify(existingFile.catalogue))
  : {
      name: 'Weapons',
      id: makeId('catalogue:weapons'),
      battleScribeVersion: '2.03',
      gameSystemId: systemFile ? systemFile.id : '',
      gameSystemRevision: 1,
      library: true,
      revision: 1,
      type: 'catalogue',
      sharedSelectionEntries: [],
    };
catalogue.sharedProfiles = ruleProfiles;
catalogue.sharedSelectionEntries = [...existingEntries, ...newEntries];
fs.writeFileSync(outPath, JSON.stringify({ catalogue }, null, 2) + '\n');

// ----------------------------------------------------- 5. report
const line = (s = '') => console.log(s);
line(`API: ${api.name} (${weapons.size} distinct weapons found)`);
line(`Existing entries kept untouched: ${matchedIdx.size} matched, ${existingEntries.length - matchedIdx.size} not in API`);
line(`New entries added: ${newEntries.length}`);
line(`Written to: ${outPath}`);
if (newEntries.length) {
  line('\nNew:');
  newEntries.forEach((e) => line(`  + ${e.name}`));
}
if (notes.length) {
  line('\nMatched by profile instead of name (check that these are the same weapon):');
  notes.forEach((n) => line(`  ~ ${n}`));
}
if (audit.length) {
  line('\nExisting entries that differ from the API (not changed, please review):');
  audit.forEach((a) => line(`  ! ${a}`));
}
const orphans = existingEntries.filter((_, i) => !matchedIdx.has(i));
if (orphans.length) {
  line('\nIn your Weapons.json but not used by this army in the API:');
  orphans.forEach((e) => line(`  ? ${e.name}`));
}
if (missingRules.size) {
  line('\nWeapon special rules with no profile in the game system (not linked yet):');
  for (const [r, ws] of missingRules) line(`  - ${r}  (${ws.length} weapon${ws.length > 1 ? 's' : ''})`);
} else if (!systemFile && newEntries.some((e) => !e.infoLinks)) {
  line('\nNote: no --system given, so no weapon special rules were linked.');
}
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
