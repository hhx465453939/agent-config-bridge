/**
 * dsh sidebar market module: the shipped plugin source, the module report, and
 * the per-profile install state that report reads.
 *
 *   node --test bridge/test/market-links.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import {
  MARKET_LINKS_PACKAGE,
  inspectMarketLinksSource,
  marketLinksSourceDir,
  planMarketLinksModule,
  profileInstallStates,
} from '../lib/market-links.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = marketLinksSourceDir(repo);

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-links-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Run client.js the way the browser module table does: a loader stub captures
 * the module, a React stub turns h() into plain objects, and the slots stub
 * records what `apply` registers. This catches a broken bundle without a GUI.
 */
const loadClient = () => {
  const source = readFileSync(join(sourceDir, 'client.js'), 'utf8');
  let module = null;
  const registrations = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
  };
  const context = {
    window: { __ModuleLoader__: { load: (value) => { module = value; } } },
    require: (id) => {
      if (id === 'react') return React;
      throw new Error(`unexpected require(${id})`);
    },
    console,
    setTimeout,
    navigator: { clipboard: { writeText: async () => {} } },
  };
  createContext(context);
  runInContext(source, context);
  assert.ok(module, 'client.js did not register itself with the module loader');
  const api = module.factory(context.require);
  const ctx = {
    slots: {
      inject: (name, factory) => {
        const produced = factory();
        const handles = produced && typeof produced.next === 'function' ? [...produced] : [produced];
        for (const handle of handles) registrations.push({ slot: name, handle });
      },
      register: (meta, component) => ({ meta, component }),
    },
  };
  api.apply(ctx);
  return { module, api, registrations };
};

/** Collect every href in a rendered React tree. */
const collectHrefs = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.props?.href === 'string') out.push(node.props.href);
  collectHrefs(node.children, out);
  return out;
};

// --- the shipped plugin ------------------------------------------------------

test('the source checkout carries every file the manifest promises', () => {
  const report = inspectMarketLinksSource(repo);
  assert.deepEqual(report.problems, []);
  assert.equal(report.dir, sourceDir);
  assert.deepEqual(report.files.map((file) => file.name).sort(), ['client.js', 'cordis.patch.yml', 'index.js', 'package.json']);
  assert.ok(report.files.every((file) => file.present));
  assert.equal(report.manifest.name, MARKET_LINKS_PACKAGE);
  assert.equal(report.manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(report.manifest.dsh.client.platform, 'web');
});

test('the client module mounts a sidebar row and the panel that row opens', () => {
  const { module, registrations } = loadClient();
  assert.equal(module.id, MARKET_LINKS_PACKAGE);

  const row = registrations.find((entry) => entry.handle.meta?.name === 'sidebar.panellist');
  assert.ok(row, 'no sidebar row was registered');
  assert.equal(row.slot, 'sidebar.panellist');
  assert.equal(row.handle.meta.id, 'market-links');
  assert.equal(row.handle.meta.label, '插件市场');
  assert.equal(typeof row.handle.component, 'function');

  const panel = registrations.find((entry) => entry.handle.meta?.name === 'main');
  assert.ok(panel, 'no main panel was registered');
  assert.equal(panel.handle.meta.key, row.handle.meta.id, 'panel key must equal the sidebar row id');
  assert.equal(typeof panel.handle.component, 'function');
});

test('the panel renders every market as a unique https link', () => {
  const { registrations } = loadClient();
  const panel = registrations.find((entry) => entry.handle.meta?.name === 'main');
  const tree = panel.handle.component({});
  const hrefs = collectHrefs(tree);

  assert.ok(hrefs.length >= 15, `expected the full catalogue, got ${hrefs.length} links`);
  assert.equal(new Set(hrefs).size, hrefs.length, 'a link is listed twice');
  for (const href of hrefs) {
    assert.match(href, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^ ]*)?$/, `not a plain https URL: ${href}`);
  }
  assert.ok(hrefs.some((href) => href.includes('topics/dsh-plugin')), 'the GitHub topic entry is missing');
});

test('an incomplete checkout is reported as problems, not thrown on', () => withTmp((dir) => {
  const report = inspectMarketLinksSource(dir);
  assert.equal(report.manifest, null);
  assert.ok(report.problems.some((problem) => problem.includes('source file missing: client.js')));
  assert.ok(report.problems.length >= 4, 'every missing file should be named');
}));

// --- the module report ------------------------------------------------------

test('profile state separates a real install from a bundle entry with no package', () => withTmp((home) => {
  const profiles = join(home, '.dsh', 'profiles');

  const installed = join(profiles, 'desktop', 'node_modules', MARKET_LINKS_PACKAGE);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: MARKET_LINKS_PACKAGE }));
  writeFileSync(join(profiles, 'desktop', 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: { [MARKET_LINKS_PACKAGE]: 'file:../somewhere/market-links' },
  }));

  mkdirSync(join(profiles, 'web'), { recursive: true });
  writeFileSync(join(profiles, 'web', 'package.json'), JSON.stringify({
    name: 'web-profile',
    dsh: { profile: { bundles: [MARKET_LINKS_PACKAGE] } },
  }));

  const states = profileInstallStates(home);
  assert.deepEqual(states.map((state) => state.profile), ['desktop', 'web']);
  assert.equal(states[0].installed, true);
  assert.equal(states[0].dependency !== null, true);
  assert.equal(states[0].bundled, false);
  assert.equal(states[1].installed, false);
  assert.equal(states[1].bundled, true);
  assert.equal(states[1].nodeModules, false);
}));

test('an unreadable profile manifest is reported without failing the scan', () => withTmp((home) => {
  const dir = join(home, '.dsh', 'profiles', 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ not json');

  const states = profileInstallStates(home);
  assert.equal(states.length, 1);
  assert.equal(states[0].installed, false);
  assert.match(states[0].error ?? '', /unreadable/);
}));

test('a machine with no profiles reports none instead of guessing', () => withTmp((home) => {
  assert.deepEqual(profileInstallStates(home), []);
}));

test('the module plan carries install commands and makes no file actions', () => withTmp((home) => {
  const plan = planMarketLinksModule({ repo, home });
  assert.equal(plan.ok, true);
  assert.equal(plan.package, MARKET_LINKS_PACKAGE);
  assert.deepEqual(plan.profiles, []);
  assert.equal('actions' in plan, false, 'this module must never claim a write it did not make');
  assert.ok(plan.steps.some((step) => step.kind === 'desktop' && step.text.includes(sourceDir)));
  assert.ok(plan.steps.some((step) => step.kind === 'web' && step.text.includes('dsh plugin --profile web add')));
  assert.ok(plan.steps.some((step) => step.kind === 'remove' && step.text.includes(MARKET_LINKS_PACKAGE)));
}));