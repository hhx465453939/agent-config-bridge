/**
 * dsh sidebar market module (`dsh/market-links`): validate the source, report
 * whether each profile already has it, and print the two install commands.
 *
 * WHY THIS MODULE WRITES NOTHING
 *
 * gates and commands are copied into `~/.dsh/plugins/` and mounted with a patch
 * row, because all of their behaviour lives in the Host half. A plugin with a
 * browser half is different: dsh builds the Client module graph from *profile
 * packages*, so a path-mounted row would serve the Host half and silently drop
 * the sidebar row and the panel. The only install that works is adding the
 * package to the profile's dependency graph — and `.dsh/profiles` sits in this
 * target's `never_touch` list, because the GUI writes that file too.
 *
 * So this module does the part a checkout can honestly do: validate the source,
 * compare each profile against what a successful install looks like, and print
 * the exact commands (in-app for the Desktop profile, `dsh plugin` for a CLI
 * profile). Nothing here pretends a write happened.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Package a profile must depend on. Must equal dsh/market-links/package.json's name. */
export const MARKET_LINKS_PACKAGE = 'dsh-market-links';

/** Files a complete source checkout carries. README is documentation, not runtime. */
const REQUIRED_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml'];

/** Where the plugin source lives inside this repository. */
export const marketLinksSourceDir = (repo) => join(repo, 'dsh', 'market-links');

/**
 * Read and parse the package manifest.
 * @throws when the file is missing or not JSON -- a caller that cannot read the
 *   manifest has nothing useful to say about the module.
 */
export const readMarketLinksManifest = (repo) => {
  const file = join(marketLinksSourceDir(repo), 'package.json');
  if (!existsSync(file)) throw new Error(`market-links: package.json missing at ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`market-links: package.json is not valid JSON (${error.message})`);
  }
};

/**
 * Source-side facts: which files exist, and whether the manifest promises what
 * a browser-half plugin needs (a bundle patch that exists, and a client half).
 * @returns {{dir: string, files: Array<{name: string, present: boolean}>, manifest: object|null, problems: string[]}}
 */
export const inspectMarketLinksSource = (repo) => {
  const dir = marketLinksSourceDir(repo);
  const files = REQUIRED_FILES.map((name) => ({ name, present: existsSync(join(dir, name)) }));
  const problems = files.filter((file) => !file.present).map((file) => `source file missing: ${file.name}`);
  let manifest = null;
  try {
    manifest = readMarketLinksManifest(repo);
  } catch (error) {
    problems.push(error.message);
  }
  if (manifest !== null) {
    if (manifest.name !== MARKET_LINKS_PACKAGE) {
      problems.push(`package.json declares "${manifest.name}", expected "${MARKET_LINKS_PACKAGE}"`);
    }
    const patch = manifest.dsh?.bundle?.patch;
    if (typeof patch !== 'string') problems.push('package.json declares no dsh.bundle.patch');
    else if (!existsSync(join(dir, patch))) problems.push(`dsh.bundle.patch points at a missing file: ${patch}`);
    if (manifest.dsh?.client === undefined) problems.push('package.json declares no dsh.client, so the sidebar half cannot load');
  }
  return { dir, files, manifest, problems };
};

/**
 * What each profile looks like on disk: does it depend on the package, is the
 * package listed as a bundle, and did the package actually land in node_modules.
 * @returns {Array<object>} one row per profile directory, sorted by name
 */
export const profileInstallStates = (home, packageName = MARKET_LINKS_PACKAGE) => {
  const root = join(home, '.dsh', 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      const packageFile = join(dir, 'package.json');
      let manifest = null;
      let error = null;
      try {
        manifest = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : null;
      } catch (parseError) {
        error = `profile package.json unreadable: ${parseError.message}`;
      }
      const dependency = manifest?.dependencies?.[packageName] ?? null;
      const bundles = manifest?.dsh?.profile?.bundles;
      const bundled = Array.isArray(bundles) && bundles.includes(packageName);
      const nodeModules = existsSync(join(dir, 'node_modules', packageName, 'package.json'));
      return {
        profile: entry.name,
        dir,
        packageFile,
        dependency,
        bundled,
        nodeModules,
        installed: nodeModules && (dependency !== null || bundled),
        error,
      };
    })
    .sort((left, right) => left.profile.localeCompare(right.profile));
};

/**
 * The whole module report: source state, per-profile state, and the commands a
 * human (or an agent) runs to finish the install. Carries no file actions on
 * purpose -- see the header.
 */
export const planMarketLinksModule = ({ repo, home }) => {
  const source = inspectMarketLinksSource(repo);
  const profiles = profileInstallStates(home);
  const dir = source.dir;
  return {
    package: MARKET_LINKS_PACKAGE,
    source,
    profiles,
    steps: [
      { kind: 'desktop', text: `Desktop: Settings-sidebar Plugins -> Add plugin -> ${dir} (the desktop profile belongs to the app; dsh plugin --profile desktop is refused)` },
      { kind: 'web', text: `Web profile: dsh plugin --profile web add "${dir}"` },
      { kind: 'remove', text: `Remove: the in-app Plugins page, or dsh plugin --profile web remove ${MARKET_LINKS_PACKAGE}` },
    ],
    ok: source.problems.length === 0,
  };
};