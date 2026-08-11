// @ts-nocheck
/**
 * Zero-install typechecker: runs the real TypeScript compiler (fetched from a
 * CDN at dev time — nothing installs locally) over the same entry points CI
 * checks with `deno check`, straight in the browser. Approximates CI's
 * strict+checkJs configuration; a clean run here means CI's typecheck will be
 * clean or very nearly so.
 */
// Track the TypeScript line Deno ships (Deno 2.x follows current TS) so a
// clean run here predicts a clean `deno check` in CI.
const TS_VERSION = '5.9.2';
const TS_URL = `https://esm.sh/typescript@${TS_VERSION}`;
const LIB_URL = `https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib/`;

const ENTRIES = [
  '/js/main.js',
  '/js/worker/compute.js',
  '/js/worker/match.js',
  '/tests/browser.js',
];

const summary = document.getElementById('summary');
const out = document.getElementById('out');

const ts = (await import(TS_URL)).default;
summary.textContent = `TypeScript ${ts.version} — checking…`;
await new Promise((res) => setTimeout(res, 30)); // let the status paint

/** Synchronous fetch (the compiler host API is synchronous). */
function fetchSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  try {
    xhr.send();
  } catch {
    return undefined;
  }
  return xhr.status === 200 ? xhr.responseText : undefined;
}

const fileCache = new Map();
function readFile(name) {
  if (fileCache.has(name)) return fileCache.get(name);
  let text;
  if (name.startsWith('/lib/')) {
    text = fetchSync(LIB_URL + name.slice(5));
  } else {
    text = fetchSync(name);
  }
  fileCache.set(name, text);
  return text;
}

const options = {
  allowJs: true,
  checkJs: true,
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
};

const host = {
  getSourceFile(name, langVersion) {
    const text = readFile(name);
    return text === undefined
      ? undefined
      : ts.createSourceFile(name, text, langVersion, true);
  },
  getDefaultLibFileName: () => '/lib/lib.es2022.full.d.ts',
  getDefaultLibLocation: () => '/lib',
  writeFile: () => {},
  getCurrentDirectory: () => '/',
  getCanonicalFileName: (f) => f,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => '\n',
  fileExists: (name) => readFile(name) !== undefined,
  readFile,
  resolveModuleNameLiterals(literals, containingFile) {
    return literals.map((lit) => {
      const spec = lit.text;
      const base = containingFile.slice(0, containingFile.lastIndexOf('/'));
      const resolved = new URL(spec, 'http://x' + base + '/').pathname;
      return { resolvedModule: { resolvedFileName: resolved, extension: '.js' } };
    });
  },
};

const program = ts.createProgram(ENTRIES, options, host);
const diags = [
  ...program.getSemanticDiagnostics(),
  ...program.getSyntacticDiagnostics(),
];

const lines = [];
for (const d of diags) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    lines.push(`${d.file.fileName}:${line + 1}:${character + 1}  TS${d.code}  ${msg}`);
  } else {
    lines.push(`TS${d.code}  ${msg}`);
  }
}

summary.textContent =
  lines.length === 0 ? `TYPECHECK CLEAN (TypeScript ${ts.version})` : `${lines.length} type errors`;
summary.className = lines.length === 0 ? 'ok' : 'err';
out.textContent = lines.join('\n');
console.log(`DOTDOT-TYPECHECK: ${lines.length} errors`);
for (const l of lines) console.log(l);
