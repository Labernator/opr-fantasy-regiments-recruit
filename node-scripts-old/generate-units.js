#!/usr/bin/env node
'use strict';
/**
 * generate-units.js
 *
 * Builds the units of an army catalogue from the OPR API JSON, in the layout of
 * the hand-made Dark Elves catalogue: unit size, model stats, special rules,
 * weapons, upgrades, unit costs, categories and the per-unit limits.
 *
 * Weapons, upgrade entries (auras, mounts, spells ...) and rule profiles are
 * never created here, only linked by name from your libraries/catalogue.
 *
 * Usage:
 *   node generate-units.js <army-api.json> --catalogue DarkElves.json
 *        --system opr-recruit.json [--weapons Weapons.json]
 *        [--rules Special_Rules.json] [--out DarkElves.generated.json]
 *        [--redo "Hydra,Corsairs" | --redo all]
 *
 *   --redo all   rebuild every unit from the API (use this to compare the result
 *                with your hand-made catalogue, e.g. with compare-units.js).
 *                Everything that is not a unit stays as it is in --catalogue.
 *   --redo A,B   rebuild only these units. Existing units are skipped otherwise.
 *   --out        default: <catalogue>.generated.json. Inputs are never modified.
 */
const fs = require('fs');
const crypto = require('crypto');

// ------------------------------------------------------------- CONFIG
const SIZE_MULTIPLES = [1, 2, 3]; // 5 / 10 / 15 models for a unit of 5
const HEAVY_TOUGH = 7; // single models with Tough >= this: "Vehicles / Monsters"
const CATEGORY = {
  hero: 'Heroes',
  core: 'Core Units',
  light: 'Light Vehicles / Small Monsters',
  heavy: 'Vehicles / Monsters',
  artillery: 'Artillery',
};
const COPY_LIMIT = 2; // max copies of one unit (regardless of loadout)
const COST_LIMIT_PERCENT = 35; // a unit may cost at most this % of the points limit
const COMMAND_OPTIONS = ['sergeant', 'banner', 'musician']; // -> group "Command"
const MOUNT_RULES = ['Tough', 'Fast', 'Flying', 'Armor', 'Impact', 'Ravage']; // item content that marks a mount

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const apiPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (!apiPath || !opt('--catalogue') || !opt('--system')) {
  console.error('Usage: node generate-units.js <army-api.json> --catalogue DarkElves.json --system opr-recruit.json [--weapons Weapons.json] [--rules Special_Rules.json] [--out file] [--redo "A,B"|all]');
  process.exit(1);
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const api = readJson(apiPath);
const catFile = readJson(opt('--catalogue'));
const sys = readJson(opt('--system')).gameSystem;
const weaponsCat = opt('--weapons') ? readJson(opt('--weapons')).catalogue : null;
const rulesCat = opt('--rules') ? readJson(opt('--rules')).catalogue : null;
const outPath = opt('--out') || opt('--catalogue').replace(/\.json$/, '') + '.generated.json';
const catalogue = catFile.catalogue;

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const singular = (s) => norm(s).replace(/s$/, '');
const baseRule = (s) => norm(s).replace(/\s*\(.*\)\s*$/, '');

// ---------------------------------------------- --redo: drop old units
const redoArg = (opt('--redo') || '').split(',').map((s) => norm(s)).filter(Boolean);
const redoAll = redoArg.includes('all');
const redo = new Set(redoArg);
const redoSort = new Map(); // keeps the sort position of regenerated units
catalogue.sharedSelectionEntries = catalogue.sharedSelectionEntries || [];
catalogue.entryLinks = catalogue.entryLinks || [];
catalogue.sharedProfiles = catalogue.sharedProfiles || [];
if (redo.size) {
  const drop = catalogue.sharedSelectionEntries.filter((e) => e.type === 'unit' && (redoAll || redo.has(norm(e.name))));
  const dropIds = new Set(drop.map((e) => e.id));
  drop.forEach((e) => redoSort.set(norm(e.name), e.sortIndex));
  catalogue.sharedSelectionEntries = catalogue.sharedSelectionEntries.filter((e) => !dropIds.has(e.id));
  catalogue.entryLinks = catalogue.entryLinks.filter((l) => !dropIds.has(l.targetId));
  catalogue.sharedProfiles = catalogue.sharedProfiles.filter((p) => !(p.typeName === 'Model' && (redoAll || redo.has(norm(p.name)))));
}

// ------------------------------------------------------------------ ids
const usedIds = new Set();
(function collect(o) {
  if (Array.isArray(o)) return o.forEach(collect);
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'id' && typeof v === 'string') usedIds.add(v);
      else collect(v);
    }
  }
})([catalogue, sys, weaponsCat, rulesCat]);

/** Deterministic 4x4-hex id: the same key always gives the same id. */
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

// ---------------------------------------------- game-system constants
const costType = (n) => (sys.costTypes || []).find((c) => c.name === n);
const PTS_ID = (costType('pts') || sys.costTypes[0]).id;
const DEFAULT_LIMIT = (costType('pts') || sys.costTypes[0]).defaultCostLimit || 750;
const UNIT_COST = costType('unit');
if (!UNIT_COST) console.warn('Warning: no "unit" cost type in the game system, unit costs are skipped.');
const profType = (n) => (sys.profileTypes || []).find((p) => p.name === n);
const UNIT_TYPE = profType('Unit');
const UNIT_SIZE_CHAR = UNIT_TYPE.characteristicTypes.find((c) => c.name === 'Unit Size').id;
const MODEL_TYPE = profType('Model');
const modelChar = (n) => MODEL_TYPE.characteristicTypes.find((c) => c.name === n).id;
const sysCat = (name) => (sys.categoryEntries || []).find((c) => c.name === name);
const sysCatPrefix = (prefix) => (sys.categoryEntries || []).find((c) => c.name.startsWith(prefix));
const factionCat = sysCat(`Faction: ${api.name}`);
const unitsLimitCat = sysCatPrefix('Units:');
const heroesLimitCat = sysCatPrefix('Heroes:');
if (!factionCat) console.warn(`Warning: category "Faction: ${api.name}" not found in the game system.`);
if (!unitsLimitCat) console.warn('Warning: no "Units: ..." limit category in the game system, units are not linked to it.');
if (!heroesLimitCat) console.warn('Warning: no "Heroes: ..." limit category in the game system, heroes are not linked to it.');

// ------------------------------------------------ lookup of existing things
const entryIndex = new Map(); // normalized name -> { id, entry, source }
const weaponSigIndex = new Map();
const profileIndex = new Map(); // normalized name -> { id, name }
function indexEntries(list, source) {
  for (const e of list || []) {
    if (e.type === 'unit') continue;
    if (!entryIndex.has(norm(e.name))) entryIndex.set(norm(e.name), { id: e.id, entry: e, source });
    const p = (e.profiles || []).find((x) => x.typeName === 'Weapon');
    if (p) {
      const ch = {};
      p.characteristics.forEach((c) => (ch[c.name] = c.$text));
      const rules = (e.infoLinks || []).map((l) => baseRule(l.name));
      const sig = [norm(p.name), ch.Rng, ch.ATK, ch.AP, rules.sort().join('+')].join('|');
      if (!weaponSigIndex.has(sig)) weaponSigIndex.set(sig, { id: e.id, entry: e, source });
    }
  }
}
function indexProfiles(list, source) {
  for (const p of list || []) if (!profileIndex.has(norm(p.name))) profileIndex.set(norm(p.name), { id: p.id, name: p.name, source });
}
indexEntries(weaponsCat && weaponsCat.sharedSelectionEntries, 'Weapons');
indexEntries(rulesCat && rulesCat.sharedSelectionEntries, 'Special Rules');
indexEntries(catalogue.sharedSelectionEntries, catalogue.name);
indexEntries(sys.sharedSelectionEntries, 'game system');
indexProfiles(rulesCat && rulesCat.sharedProfiles, 'Special Rules');
indexProfiles(weaponsCat && weaponsCat.sharedProfiles, 'Weapons');
indexProfiles(sys.sharedProfiles, 'game system');

const ruleLabel = (r) => (r.rating != null ? `${r.name}(${r.rating})` : r.name);
function weaponLabel(w) {
  if (w.label) return w.label;
  const rules = (w.specialRules || []).slice().sort((a, b) =>
    a.name === 'AP' ? -1 : b.name === 'AP' ? 1 : ruleLabel(a).localeCompare(ruleLabel(b)));
  const parts = [];
  if (w.range > 0) parts.push(`${w.range}"`);
  parts.push(`A${w.attacks}`);
  rules.forEach((r) => parts.push(ruleLabel(r)));
  return `${w.name} (${parts.join(', ')})`;
}
function weaponSig(w) {
  const ap = (w.specialRules || []).find((r) => r.name === 'AP');
  const rules = (w.specialRules || []).filter((r) => r.name !== 'AP').map((r) => baseRule(r.name)).sort();
  return [norm(w.name), w.range > 0 ? `${w.range}"` : '-', String(w.attacks), ap && ap.rating != null ? String(ap.rating) : '-', rules.join('+')].join('|');
}
const bySignature = new Map(); // API label -> existing entry name (for the report)
function resolveWeapon(w) {
  const byName = entryIndex.get(norm(weaponLabel(w)));
  if (byName) return byName;
  const bySig = weaponSigIndex.get(weaponSig(w));
  if (bySig) bySignature.set(weaponLabel(w), bySig.entry.name);
  return bySig || null;
}
/** Upgrade items: exact label first, then "<name> (" if that is unambiguous. */
function resolveItem(option, gain) {
  for (const n of [option.label, gain && gain.label]) if (n && entryIndex.has(norm(n))) return entryIndex.get(norm(n));
  const name = gain && gain.name ? norm(gain.name) : null;
  if (!name) return null;
  const hits = [...entryIndex.entries()].filter(([k]) => k === name || k.startsWith(`${name} (`));
  return hits.length === 1 ? hits[0][1] : null;
}
/** Rule profile: "Tough (3)" first, then the plain rule name (rating then missing). */
function resolveRule(r, report, where) {
  const cands = r.rating != null ? [`${r.name} (${r.rating})`, `${r.name}(${r.rating})`] : [];
  for (const c of cands) if (profileIndex.has(norm(c))) return profileIndex.get(norm(c));
  const generic = profileIndex.get(norm(r.name));
  if (generic) {
    if (r.rating != null) report.genericRules.set(`${r.name} (${r.rating})`, [...(report.genericRules.get(`${r.name} (${r.rating})`) || []), where]);
    return generic;
  }
  report.missingRules.set(r.label || r.name, [...(report.missingRules.get(r.label || r.name) || []), where]);
  return null;
}

// -------------------------------------------------------- node builders
const cons = (key, type, value) => ({ id: makeId(key), field: 'selections', scope: 'parent', shared: true, type, value });
const costs = (v) => (v ? [{ name: 'pts', typeId: PTS_ID, value: v }] : undefined);
const costsWithUnit = (pts, units) => {
  const a = [];
  if (pts) a.push({ name: 'pts', typeId: PTS_ID, value: pts });
  if (units && UNIT_COST) a.push({ name: UNIT_COST.name, typeId: UNIT_COST.id, value: units });
  return a.length ? a : undefined;
};
const hasMaxConstraint = (target) => ((target.entry && target.entry.constraints) || []).some((c) => c.type === 'max');

function makeLink({ key, name, target, sortIndex, cost, constraints, modifiers, children, infoLinks }) {
  const l = { name, id: makeId(key), hidden: false, import: true };
  if (sortIndex != null) l.sortIndex = sortIndex;
  l.targetId = target.id;
  l.type = 'selectionEntry';
  if (constraints && constraints.length) l.constraints = constraints;
  if (costs(cost)) l.costs = costs(cost);
  if (modifiers && modifiers.length) l.modifiers = modifiers;
  if (children && children.length) l.entryLinks = children;
  if (infoLinks && infoLinks.length) l.infoLinks = infoLinks;
  return l;
}

/** cost = base cost for the standard size; set to cost*k when the k-times size is chosen */
function sizeModifiers(unitId, sizeIds, cost) {
  if (!cost) return [];
  return SIZE_MULTIPLES.slice(1).map((k, i) => ({
    field: PTS_ID,
    type: 'set',
    value: cost * k,
    conditions: [{
      childId: sizeIds[i + 1],
      field: 'selections',
      includeChildForces: false,
      includeChildSelections: true,
      scope: unitId,
      shared: true,
      type: 'atLeast',
      value: 1,
    }],
  }));
}
const optionCost = (o, unit) => {
  const c = (o.costs || []).find((x) => x.unitId === unit.id);
  return c ? c.cost : o.cost || 0;
};

// ----------------------------------------------- section classification
const contentNames = (gain) => (gain.content || []).map((c) => c.name);
const isMountOption = (o) =>
  o.gains.some((g) => (g.content || []).some((c) => c.type === 'ArmyBookWeapon' || MOUNT_RULES.includes(c.name)));
const isAuraOption = (o) =>
  o.gains.some((g) => contentNames(g).some((n) => /aura$/i.test(n) || n === 'Caster') || /aura\)/i.test(o.label));

function groupNameFor(pkg, s) {
  const opts = s.options;
  if (opts.every((o) => COMMAND_OPTIONS.includes(norm(o.label)))) return 'Command';
  if (opts.every((o) => o.gains.length && o.gains.every((g) => g.type === 'ArmyBookWeapon'))) return 'Ranged Weapons';
  if (opts.some(isMountOption)) return 'Abilities & Mounts';
  if (/^specialists/i.test(pkg.hint || '') || opts.every(isAuraOption)) return 'Auras';
  return 'Upgrades';
}

// -------------------------------------------------------- unit builder
const pkgByUid = new Map((api.upgradePackages || []).map((p) => [p.uid, p]));
const spellsEntry = entryIndex.get(norm(`${api.name} Army Spells`));

function categoryFor(u) {
  const rules = u.rules.map((r) => r.name);
  const tough = (u.rules.find((r) => r.name === 'Tough') || {}).rating || 1;
  if (rules.includes('Hero')) return CATEGORY.hero;
  if (rules.includes('Artillery')) return CATEGORY.artillery;
  if (u.size > 1) return CATEGORY.core;
  return tough >= HEAVY_TOUGH ? CATEGORY.heavy : CATEGORY.light;
}

function buildUnit(u, sortIndex, report) {
  const k = (s) => `unit:${norm(u.name)}:${s}`;
  const unitId = makeId(k('entry'));
  const sized = u.size > 1;
  const isHero = u.rules.some((r) => r.name === 'Hero');
  const category = categoryFor(u);
  const catEntry = sysCat(category);
  const note = (msg) => report.problems.push(`${u.name}: ${msg}`);

  // ---- model stats: Qua/Def/Tough (Tough comes from the Tough(n) rule, else 1)
  const toughRule = u.rules.find((r) => r.name === 'Tough');
  const modelProfile = (id) => ({
    name: u.name,
    id,
    hidden: false,
    typeId: MODEL_TYPE.id,
    typeName: 'Model',
    characteristics: [
      { name: 'Qua', $text: `${u.quality}+`, typeId: modelChar('Qua') },
      { name: 'Def', $text: `${u.defense}+`, typeId: modelChar('Def') },
      { name: 'Tough', $text: String(toughRule && toughRule.rating != null ? toughRule.rating : 1), typeId: modelChar('Tough') },
    ],
  });
  let sharedProfileId = null;
  if (sized) {
    sharedProfileId = makeId(k('modelprofile'));
    report.sharedProfiles.push(modelProfile(sharedProfileId));
  }

  // ---- special rules of the unit
  const ruleLinks = [];
  for (const r of u.rules) {
    const p = resolveRule(r, report, u.name);
    if (p) ruleLinks.push({ name: p.name, id: makeId(k(`rule:${norm(p.name)}`)), hidden: false, targetId: p.id, type: 'profile' });
  }
  for (const item of u.items || []) {
    for (const c of item.content || []) {
      if (c.type !== 'ArmyBookRule') continue;
      const p = resolveRule({ name: c.name, label: c.name, rating: c.rating }, report, u.name);
      if (p && !ruleLinks.some((l) => l.targetId === p.id)) ruleLinks.push({ name: p.name, id: makeId(k(`rule:${norm(p.name)}`)), hidden: false, targetId: p.id, type: 'profile' });
    }
  }
  ruleLinks.sort((a, b) => a.name.localeCompare(b.name));

  // ---- size group (sized units only)
  let sizeGroup = null;
  const sizeIds = [];
  if (sized) {
    const entries = SIZE_MULTIPLES.map((m) => {
      const id = makeId(k(`size${m}`));
      sizeIds.push(id);
      const e = {
        name: `${u.size * m} ${u.name}`,
        id,
        hidden: false,
        type: 'upgrade',
        constraints: [cons(k(`size${m}:min`), 'min', 0), cons(k(`size${m}:max`), 'max', 1)],
        costs: costsWithUnit(u.cost * m, m),
        infoLinks: [{ name: u.name, id: makeId(k(`size${m}:info`)), hidden: false, targetId: sharedProfileId, type: 'profile' }],
      };
      if (m > 1 && u.cost * m * 100 > COST_LIMIT_PERCENT * DEFAULT_LIMIT) {
        // hide sizes that would break the "max N% of the points limit" rule
        e.modifiers = [{
          field: 'hidden',
          type: 'set',
          value: true,
          conditions: [{ field: `limit::${PTS_ID}`, percentValue: true, scope: 'self', shared: true, type: 'greaterThan', value: COST_LIMIT_PERCENT }],
        }];
      }
      return e;
    });
    sizeGroup = {
      name: 'Unit Size',
      id: makeId(k('sizegroup')),
      defaultSelectionEntryId: sizeIds[0],
      hidden: false,
      sortIndex: 0,
      constraints: [cons(k('sizegroup:min'), 'min', 1), cons(k('sizegroup:max'), 'max', 1)],
      selectionEntries: entries,
    };
  }

  // ---- sections of this unit
  const disabled = new Set([...(u.disabledSections || []), ...(u.disabledUpgradeSections || [])]);
  const sections = [];
  for (const pid of u.upgrades || []) {
    const pkg = pkgByUid.get(pid);
    if (!pkg) { note(`upgrade package ${pid} not found in the API data`); continue; }
    for (const s of pkg.sections) {
      if (disabled.has(s.id) || disabled.has(s.uid)) continue;
      sections.push({ pkg, s });
    }
  }

  // ---- weapon groups: one per base weapon
  const weaponGroups = (u.weapons || []).map((w) => ({ w, replaces: [] }));
  for (const { pkg, s } of sections.filter((x) => x.s.variant === 'replace')) {
    for (const t of s.targets || []) {
      const g = weaponGroups.find((x) => singular(x.w.name) === singular(t));
      if (g) g.replaces.push({ pkg, s });
      else note(`replace section "${s.label}" targets "${t}", but no base weapon matches`);
    }
  }

  let groupSort = 1;
  const groups = [];
  const single = weaponGroups.length === 1;
  for (const g of weaponGroups) {
    const gk = k(`wg:${norm(g.w.name)}`);
    const baseTarget = resolveWeapon(g.w);
    if (!baseTarget) { note(`no weapon entry for base weapon "${weaponLabel(g.w)}"`); continue; }
    const baseLink = makeLink({ key: `${gk}:base`, name: weaponLabel(g.w), target: baseTarget, sortIndex: 1 });
    const links = [baseLink];
    const combined = [];
    let order = 2;
    for (const { s } of g.replaces) {
      const scale = sized && s.affects && s.affects.type === 'all';
      for (const o of s.options) {
        const ws = o.gains.filter((x) => x.type === 'ArmyBookWeapon');
        const targets = ws.map((w) => ({ w, t: resolveWeapon(w) }));
        const miss = targets.filter((x) => !x.t);
        if (!ws.length || miss.length) {
          note(`replacement "${o.label}": no weapon entry for ${miss.map((x) => `"${weaponLabel(x.w)}"`).join(', ') || 'any weapon gain'}`);
          continue;
        }
        const cost = optionCost(o, u);
        const ok = `${gk}:opt:${norm(o.label)}`;
        const mods = scale ? sizeModifiers(unitId, sizeIds, cost) : [];
        const [first, ...rest] = targets;
        if (!rest.length) {
          links.push(makeLink({ key: ok, name: weaponLabel(first.w), target: first.t, sortIndex: order++, cost, modifiers: mods }));
          continue;
        }
        // several weapons for one replacement: a local entry that carries the first
        // weapon's profile and links the others (they are selected together)
        const entry = { name: ws.map((w) => weaponLabel(w)).join(' and '), id: makeId(ok), hidden: false, import: true, sortIndex: order++, type: 'upgrade' };
        if (costs(cost)) entry.costs = costs(cost);
        const firstInfo = (first.t.entry.infoLinks || []).map((l, i) => ({ ...l, id: makeId(`${ok}:info${i}`) }));
        if (firstInfo.length) entry.infoLinks = firstInfo;
        entry.entryLinks = rest.map((r, i) => makeLink({
          key: `${ok}:extra${i}`,
          name: weaponLabel(r.w),
          target: r.t,
          constraints: [cons(`${ok}:extra${i}:min`, 'min', 1), cons(`${ok}:extra${i}:max`, 'max', 1)],
        }));
        if (mods.length) entry.modifiers = mods;
        const wp = (first.t.entry.profiles || []).find((p) => p.typeName === 'Weapon');
        if (wp) {
          entry.profiles = [{
            name: wp.name,
            id: makeId(`${ok}:profile`),
            hidden: false,
            typeId: wp.typeId,
            typeName: 'Weapon',
            characteristics: wp.characteristics.map((c) => ({ name: c.name, $text: c.$text, typeId: c.typeId })),
          }];
        }
        combined.push(entry);
      }
    }
    const hasChoice = links.length > 1 || combined.length > 0;
    const name = single ? 'Weapons' : hasChoice && g.w.range > 0 ? 'Ranged Weapons' : g.w.name;
    if (!hasChoice) {
      // No choice: the weapon itself is min 1 / max 1 and the group has no limits,
      // so the weapon is always present and shows no checkbox.
      const forced = {};
      for (const [key, val] of Object.entries(baseLink)) {
        forced[key] = val;
        if (key === 'type') forced.constraints = [cons(`${gk}:base:min`, 'min', 1), cons(`${gk}:base:max`, 'max', 1)];
      }
      groups.push({ name, id: makeId(`${gk}:group`), hidden: false, sortIndex: groupSort++, entryLinks: [forced] });
    } else {
      const grp = {
        name,
        id: makeId(`${gk}:group`),
        defaultSelectionEntryId: baseLink.id,
        hidden: false,
        sortIndex: groupSort++,
        constraints: [cons(`${gk}:max`, 'max', 1), cons(`${gk}:min`, 'min', 1)],
      };
      if (combined.length) grp.selectionEntries = combined;
      grp.entryLinks = links;
      groups.push(grp);
    }
  }

  // ---- upgrade groups: one per upgrade section
  const usedNames = new Map();
  for (const { pkg, s } of sections.filter((x) => x.s.variant !== 'replace')) {
    const sk = k(`sec:${pkg.uid}:${s.uid || s.id}`);
    const scale = sized && s.affects && s.affects.type === 'all';

    // group limit: "up to N models" / "exactly one" / none for "any"
    let max = null;
    if (s.affects && (s.affects.type === 'up to' || s.affects.type === 'exactly')) max = s.affects.value;
    else if (s.select && s.select.type === 'exactly') max = s.select.value;

    const links = [];
    let order = 1;
    for (const o of s.options) {
      const ok = `${sk}:opt:${norm(o.label)}`;
      const cost = optionCost(o, u);
      const gain = o.gains[0];
      if (!gain) continue;
      let target = null;
      if (gain.type === 'ArmyBookWeapon') target = resolveWeapon(gain);
      else target = resolveItem(o, gain);
      if (!target) {
        report.unresolved.set(o.label, [...(report.unresolved.get(o.label) || []), u.name]);
        continue;
      }

      // extras that belong to the item: mount weapons, armour, caster spells
      const children = [];
      const infoLinks = [];
      for (const c of gain.content || []) {
        const ownLinks = (target.entry && target.entry.entryLinks) || [];
        const ownInfo = (target.entry && target.entry.infoLinks) || [];
        if (c.type === 'ArmyBookWeapon') {
          const wt = resolveWeapon(c);
          if (!wt) note(`item "${o.label}": no weapon entry for "${weaponLabel(c)}"`);
          else if (!ownLinks.some((l) => l.targetId === wt.id)) children.push(makeLink({ key: `${ok}:weapon:${norm(weaponLabel(c))}`, name: weaponLabel(c), target: wt }));
        } else if (c.name === 'Armor' && c.rating != null) {
          const ap = profileIndex.get(norm(`Armour (${c.rating}+)`));
          if (!ap) report.missingRules.set(`Armour (${c.rating}+)`, [...(report.missingRules.get(`Armour (${c.rating}+)`) || []), u.name]);
          else if (!ownInfo.some((l) => l.targetId === ap.id)) infoLinks.push({ name: ap.name, id: makeId(`${ok}:armour`), hidden: false, targetId: ap.id, type: 'profile' });
        } else if (c.name === 'Caster' && spellsEntry) {
          children.push(makeLink({
            key: `${ok}:spells`,
            name: spellsEntry.entry.name,
            target: spellsEntry,
            constraints: [cons(`${ok}:spells:min`, 'min', 1), cons(`${ok}:spells:max`, 'max', 1)],
          }));
        }
      }
      links.push(makeLink({
        key: ok,
        name: gain.type === 'ArmyBookWeapon' ? weaponLabel(gain) : target.entry.name.trim() === o.label.trim() ? o.label.trim() : target.entry.name.trim(),
        target,
        sortIndex: order++,
        cost,
        constraints: max != null || hasMaxConstraint(target) ? [] : [cons(`${ok}:max`, 'max', 1)],
        modifiers: scale ? sizeModifiers(unitId, sizeIds, cost) : [],
        children,
        infoLinks,
      }));
    }
    if (!links.length) continue;
    let name = groupNameFor(pkg, s);
    const n = (usedNames.get(name) || 0) + 1;
    usedNames.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    groups.push({
      name,
      id: makeId(`${sk}:group`),
      hidden: false,
      sortIndex: groupSort++,
      ...(max != null ? { constraints: [cons(`${sk}:max`, 'max', max)] } : {}),
      entryLinks: links,
    });
  }

  // ---- assemble the unit
  const catLinks = [];
  if (factionCat) catLinks.push({ name: factionCat.name, id: makeId(k('cat:faction')), hidden: false, primary: false, targetId: factionCat.id });
  if (catEntry) catLinks.push({ name: catEntry.name, id: makeId(k('cat:primary')), hidden: false, primary: true, targetId: catEntry.id });
  else note(`category "${category}" not found in the game system`);
  const modelCatLinks = catLinks.map((c) => ({ ...c, id: makeId(k(`model:${c.targetId}`)) }));
  if (unitsLimitCat) catLinks.push({ name: unitsLimitCat.name, id: makeId(k('cat:units')), hidden: false, primary: false, targetId: unitsLimitCat.id });
  if (isHero && heroesLimitCat) catLinks.push({ name: heroesLimitCat.name, id: makeId(k('cat:heroes')), hidden: false, primary: false, targetId: heroesLimitCat.id });

  const unit = {
    name: u.name,
    id: unitId,
    hidden: false,
    import: true,
    sortIndex,
    type: 'unit',
    categoryLinks: catLinks,
    constraints: [
      { id: makeId(k('limit:copies')), field: 'selections', includeChildForces: true, includeChildSelections: true, scope: 'roster', shared: true, type: 'max', value: COPY_LIMIT },
      { id: makeId(k('limit:cost')), field: `limit::${PTS_ID}`, includeChildSelections: true, percentValue: true, scope: 'self', shared: true, type: 'max', value: COST_LIMIT_PERCENT },
    ],
  };
  if (ruleLinks.length) unit.infoGroups = [{ name: 'Special Rules', id: makeId(k('rules')), hidden: false, infoLinks: ruleLinks }];
  unit.profiles = [{
    name: u.name,
    id: makeId(k('profile')),
    hidden: false,
    typeId: UNIT_TYPE.id,
    typeName: 'Unit',
    characteristics: [{ name: 'Unit Size', $text: String(u.size), typeId: UNIT_SIZE_CHAR }],
  }];

  if (sized) {
    unit.selectionEntryGroups = [sizeGroup, ...groups];
  } else {
    // single-model units follow the Dark Captain layout: a model entry carries cost and groups
    unit.selectionEntries = [{
      name: u.name,
      id: makeId(k('model')),
      hidden: false,
      import: true,
      type: 'model',
      categoryLinks: modelCatLinks,
      constraints: [cons(k('model:min'), 'min', 1), cons(k('model:max'), 'max', 1)],
      costs: costsWithUnit(u.cost, 1),
      profiles: [modelProfile(makeId(k('model:profile')))],
      selectionEntryGroups: groups,
    }];
  }
  report.summary.push(`${u.name}: ${category}, size ${u.size}, ${groups.length} group(s): ${groups.map((g) => g.name).join(', ')}`);
  return unit;
}

// ------------------------------------------------------------ main run
const report = {
  problems: [], unresolved: new Map(), summary: [], skipped: [], sharedProfiles: [],
  missingRules: new Map(), genericRules: new Map(),
};
const existingUnits = new Set(catalogue.sharedSelectionEntries.filter((e) => e.type === 'unit').map((e) => norm(e.name)));
let sortIndex = Math.max(0, ...catalogue.sharedSelectionEntries.filter((e) => e.type === 'unit').map((e) => e.sortIndex || 0));
const newUnits = [];
for (const u of api.units) {
  if (existingUnits.has(norm(u.name))) { report.skipped.push(u.name); continue; }
  newUnits.push(buildUnit(u, redoSort.has(norm(u.name)) ? redoSort.get(norm(u.name)) : ++sortIndex, report));
}
for (const e of newUnits) {
  catalogue.sharedSelectionEntries.push(e);
  catalogue.entryLinks.push({ name: e.name, id: makeId(`forcelink:${norm(e.name)}`), hidden: false, targetId: e.id, type: 'selectionEntry' });
}
if (report.sharedProfiles.length) catalogue.sharedProfiles = [...catalogue.sharedProfiles, ...report.sharedProfiles];

// -------------------------------------------------- self-check of links
const allIds = new Set();
(function collectAll(o) {
  if (Array.isArray(o)) return o.forEach(collectAll);
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'id' && typeof v === 'string') allIds.add(v);
      else collectAll(v);
    }
  }
})([catalogue, sys, weaponsCat, rulesCat]);
const broken = [];
for (const e of newUnits) {
  (function chk(o) {
    if (Array.isArray(o)) return o.forEach(chk);
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (['targetId', 'childId', 'defaultSelectionEntryId'].includes(k) && typeof v === 'string' && !allIds.has(v)) broken.push(`${e.name}: ${k} ${v} does not exist`);
        else if (k === 'scope' && typeof v === 'string' && /^[0-9a-f]{4}-/.test(v) && !allIds.has(v)) broken.push(`${e.name}: scope ${v} does not exist`);
        else chk(v);
      }
    }
  })(e);
}

fs.writeFileSync(outPath, JSON.stringify({ catalogue }, null, 2) + '\n');

// ------------------------------------------------------------- report
const line = (s = '') => console.log(s);
const uniq = (a) => [...new Set(a)].join(', ');
line(`API: ${api.name} v${api.versionString || '?'} (${api.units.length} units)`);
line(`Skipped (already in the catalogue): ${report.skipped.join(', ') || '-'}`);
line(`Generated ${newUnits.length} units -> ${outPath}\n`);
report.summary.forEach((s) => line(`  + ${s}`));
if (bySignature.size) {
  line('\nWeapons linked by stats because the name differs (check they are the same):');
  for (const [apiLabel, name] of bySignature) line(`  ~ ${apiLabel}  ->  ${name}`);
}
if (report.unresolved.size) {
  line('\nNo entry found for these upgrades (not linked, please create them or fix the name):');
  for (const [label, us] of report.unresolved) line(`  - ${label}   [${uniq(us)}]`);
}
if (report.genericRules.size) {
  line('\nRules linked without their rating, because no profile like "Tough (6)" exists:');
  for (const [label, us] of report.genericRules) line(`  ~ ${label}   [${uniq(us)}]`);
}
if (report.missingRules.size) {
  line('\nRules with no profile at all (not linked):');
  for (const [label, us] of report.missingRules) line(`  - ${label}   [${uniq(us)}]`);
}
if (report.problems.length) {
  line('\nOther problems:');
  report.problems.forEach((p) => line(`  ! ${p}`));
}
line(broken.length ? `\nSelf-check FAILED:\n  ${broken.join('\n  ')}` : '\nSelf-check: all link targets, condition ids and defaults exist.');
