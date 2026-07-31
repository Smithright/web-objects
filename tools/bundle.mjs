#!/usr/bin/env node
// Bundle the live-world client into one self-contained HTML file.
//
// The repo needs no build step — web/demo.html imports the engine straight out
// of src/. This exists only for environments that cannot fetch modules from
// disk (a strict CSP, an offline copy, a pasted single file). It resolves the
// ES module graph into a tiny registry and inlines the CSS and markup.
//
//   node tools/bundle.mjs [outfile] [--page world|grove]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const PAGES = {
  world: {
    entry: 'web/world.js',
    page: 'web/world.html',
    styles: ['web/world.css'],
    out: 'dist/latticeborn-pandora.html',
    // Inlined rather than fetched: the whole point of the bundle is that it
    // runs from a file:// URL or behind a CSP that forbids fetching anything.
    avatar: 'assets/avatars/latticeborn-testbed.vrm',
  },
  grove: { entry: 'web/demo.js', page: 'web/demo.html', styles: ['web/styles.css', 'web/demo.css'], out: 'dist/latticeborn-grove.html' },
};

const flagIndex = process.argv.indexOf('--page');
const PAGE = PAGES[flagIndex > 0 ? process.argv[flagIndex + 1] : 'world'] ?? PAGES.world;
const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--') && !PAGES[arg]);
const ENTRY = join(ROOT, PAGE.entry);
const OUT = positional ? resolve(positional) : join(ROOT, PAGE.out);

const modules = new Map();

async function collect(file) {
  const id = relative(ROOT, file);
  if (modules.has(id)) return id;
  modules.set(id, null); // reserve the slot: cycles must not recurse forever
  const source = await readFile(file, 'utf8');
  const deps = new Map();

  const resolveDep = async (specifier) => {
    if (!specifier.startsWith('.')) throw new Error(`${id}: bare import "${specifier}" cannot be bundled`);
    const target = resolve(dirname(file), specifier);
    const depId = await collect(target);
    deps.set(specifier, depId);
    return depId;
  };

  let code = source;
  const exported = new Set();

  // export { a, b } from './x.js'  — re-export
  for (const match of [...code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g)]) {
    const depId = await resolveDep(match[2]);
    const names = specifiers(match[1]);
    const assignments = names
      .map(({ local, exported: alias }) => `__exports[${JSON.stringify(alias)}] = __dep${hash(depId)}[${JSON.stringify(local)}];`)
      .join(' ');
    // Assigned inline above — re-exports have no local binding to hoist later.
    code = code.replace(match[0], `const __dep${hash(depId)} = __require(${JSON.stringify(depId)}); ${assignments}`);
  }

  // import { a, b as c } from './x.js'
  for (const match of [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g)]) {
    const depId = await resolveDep(match[2]);
    const bindings = specifiers(match[1])
      .map(({ local, exported: alias }) => (local === alias ? local : `${local}: ${alias}`))
      .join(', ');
    code = code.replace(match[0], `const { ${bindings} } = __require(${JSON.stringify(depId)});`);
  }

  // import * as ns from './x.js'
  for (const match of [...code.matchAll(/import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/g)]) {
    const depId = await resolveDep(match[2]);
    code = code.replace(match[0], `const ${match[1]} = __require(${JSON.stringify(depId)});`);
  }

  // export function|class|const|let f
  code = code.replace(/^export\s+(async\s+)?(function|class|const|let|var)\s+(\w+)/gm, (_, isAsync, kind, name) => {
    exported.add(name);
    return `${isAsync ?? ''}${kind} ${name}`;
  });

  // export { a, b }
  for (const match of [...code.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)]) {
    const assignments = specifiers(match[1])
      .map(({ local, exported: alias }) => `__exports[${JSON.stringify(alias)}] = ${local};`)
      .join(' ');
    code = code.replace(match[0], assignments);
  }

  const tail = [...exported].map((name) => `__exports[${JSON.stringify(name)}] = ${name};`).join('\n');
  modules.set(id, `__def(${JSON.stringify(id)}, function (__exports, __require) {\n${code}\n${tail}\n});`);
  return id;
}

function specifiers(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [local, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      return { local, exported: alias ?? local };
    });
}

function hash(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const RUNTIME = `
const __registry = new Map();
const __cache = new Map();
function __def(id, factory) { __registry.set(id, factory); }
function __require(id) {
  if (__cache.has(id)) return __cache.get(id);
  const factory = __registry.get(id);
  if (!factory) throw new Error('module not bundled: ' + id);
  const exports = {};
  __cache.set(id, exports);
  factory(exports, __require);
  return exports;
}
`;

const entryId = await collect(ENTRY);
const styles = (await Promise.all(PAGE.styles.map((file) => readFile(join(ROOT, file), 'utf8')))).join('\n');
const page = await readFile(join(ROOT, PAGE.page), 'utf8');
const bodyOpen = page.indexOf('>', page.indexOf('<body')) + 1;
const body = page.slice(bodyOpen, page.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  // The bundled page stands alone: the sibling publication page is not with it.
  .replace(/href="index\.html"/g, 'href="#top"')
  .replace(/<a href="#top">Publication<\/a>\s*/, '');

const avatar = PAGE.avatar
  ? `<script>window.__latticebornAvatar = ${JSON.stringify(
      (await readFile(join(ROOT, PAGE.avatar))).toString('base64'),
    )};</script>\n`
  : '';

const title = /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? 'Latticeborn';
const html = `<title>${title}</title>
<style>
${styles}
</style>
${body}
${avatar}<script type="module">
${RUNTIME}
${[...modules.values()].join('\n\n')}
__require(${JSON.stringify(entryId)});
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`bundled ${modules.size} modules -> ${relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(0)} KiB)`);
