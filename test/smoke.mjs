// C0fi headless smoke test — jsdom, no browser download.
// Catches the two bug classes that slipped past static/syntax checks:
//   1. </script> inside the inline script (parse5 truncates the script → app half-dead)
//   2. null-deref after a DOM mutation (e.g. innerHTML-wipe then querySelector the wiped node)
// It loads the app in a real HTML5 parser + DOM, exercises the demos, and BUILDS a chat app and
// a form app, then re-parses each exported file to confirm it boots without throwing.
//
// Usage:  node smoke.mjs [path-to-app.html]      (default: ../c0fi-v6.0.html)
//         node smoke.mjs --self-check            (also run known-BROKEN archived versions;
//                                                 they MUST fail, proving the harness catches bugs)
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Async errors from a jsdom script (e.g. a throw inside an un-awaited startAppMode) surface as
// Node process events, not as caught exceptions. Route them into the active load's error bucket
// so a real bug reports as a test failure instead of crashing the whole runner.
let currentErrors = [];
process.on('uncaughtException', e => currentErrors.push('uncaught: ' + (e && e.message || e)));
process.on('unhandledRejection', e => currentErrors.push('unhandledRejection: ' + (e && e.message || e)));

// Load an app HTML string in jsdom with the stubs the app needs at boot, collecting any error.
async function loadApp(html) {
  const errors = [];
  currentErrors = errors;        // route process-level async errors here while this app settles
  const captured = [];           // blob contents handed to URL.createObjectURL (i.e. downloads)
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message || String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole: vc,
    url: 'http://localhost/',
    beforeParse(window) {
      window.onerror = (m) => { errors.push('onerror: ' + m); };
      window.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
      window.prompt = () => 'Smoke Test App';
      window.confirm = () => true;
      window.alert = () => {};
      // fetch: pretend Ollama is up with one model, so testConn succeeds and model lists fill in.
      window.fetch = async (url) => {
        const u = String(url);
        const body = u.includes('/api/tags') ? { models: [{ name: 'test-model' }] } : {};
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body), body: null };
      };
      // capture "downloads" (Build App) instead of writing files
      const origCreate = window.URL.createObjectURL?.bind(window.URL);
      window.URL.createObjectURL = (blob) => { captured.push(blob); return 'blob:captured/' + captured.length; };
      window.URL.revokeObjectURL = () => {};
      // jsdom lacks <dialog>.showModal — stub so Engine-settings handlers don't throw if reached
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      }
    },
  });
  await sleep(60);              // let boot + async testConn/startAppMode settle
  return { dom, window: dom.window, document: dom.window.document, errors, captured };
}

// dispatch a real 'change' event on the demo <select> so the app's handler builds the flow
function loadDemo(document, window, value) {
  const sel = document.querySelector('#demoSel');
  sel.value = value;
  sel.dispatchEvent(new window.Event('change'));
}
async function blobText(blob) {
  if (typeof blob.text === 'function') return await blob.text();
  return String(blob);           // fallback
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { failed++; console.log('  \x1b[31m✗ ' + name + '\x1b[0m' + (detail ? '  — ' + detail : '')); }
}

async function runSuite(appPath, { expectPass = true } = {}) {
  const label = appPath.split('/').pop();
  console.log('\n\x1b[1m' + label + '\x1b[0m' + (expectPass ? '' : '  (known-broken fixture — expected to FAIL)'));
  const html = readFileSync(appPath, 'utf8');
  const before = failed;

  // --- structural: no stray </script> or <!-- inside the script body ---
  const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  check('no </script> inside script body', !/<\/script/i.test(body));
  check('exactly one </script> in file', (html.match(/<\/script>/g) || []).length === 1);

  // --- T1: builder boots and a demo builds nodes (fails if the script was truncated) ---
  const app = await loadApp(html);
  check('builder loads with no thrown error', app.errors.length === 0, app.errors[0] || '');
  loadDemo(app.document, app.window, 'content');
  await sleep(20);
  const nodeCount = app.document.querySelector('#nodes').children.length;
  check('loading a demo builds nodes in the DOM', nodeCount > 0, 'nodes rendered: ' + nodeCount);

  // --- T2: every demo builds without error ---
  const opts = [...app.document.querySelectorAll('#demoSel option')].map(o => o.value).filter(Boolean);
  let demoFails = [];
  for (const v of opts) {
    app.errors.length = 0;
    loadDemo(app.document, app.window, v);
    await sleep(5);
    const n = app.document.querySelector('#nodes').children.length;
    if (app.errors.length || n === 0) demoFails.push(v + (app.errors[0] ? ' (' + app.errors[0] + ')' : ' (0 nodes)'));
  }
  check('all ' + opts.length + ' demos build cleanly', demoFails.length === 0, demoFails.join(', '));

  // --- T3: Build App on a CHAT flow → re-parse → boots into app mode clean ---
  app.captured.length = 0; app.errors.length = 0;
  loadDemo(app.document, app.window, 'chatbot');
  await sleep(10);
  app.document.querySelector('#buildAppBtn').click();
  await sleep(10);
  const chatBlob = app.captured[app.captured.length - 1];
  let chatHtml = chatBlob ? await blobText(chatBlob) : '';
  check('Build App (chat) produced a file', chatHtml.includes('__C0FI_APP__') && /"ui":"chat"/.test(chatHtml));
  if (chatHtml) {
    const re = await loadApp(chatHtml);
    check('exported CHAT app boots with no error', re.errors.length === 0, re.errors[0] || '');
    check('chat app entered app-mode (chat UI)', re.document.body.classList.contains('app-mode') && re.document.body.classList.contains('chat-app'));
  }

  // --- T4: Build App on a FORM flow → re-parse → boots clean (this is the null-deref catcher) ---
  app.captured.length = 0; app.errors.length = 0;
  loadDemo(app.document, app.window, 'content');
  await sleep(10);
  app.document.querySelector('#buildAppBtn').click();
  await sleep(10);
  const formBlob = app.captured[app.captured.length - 1];
  let formHtml = formBlob ? await blobText(formBlob) : '';
  check('Build App (form) produced a file', formHtml.includes('__C0FI_APP__') && /"ui":"form"/.test(formHtml));
  if (formHtml) {
    const re = await loadApp(formHtml);
    check('exported FORM app boots with no error', re.errors.length === 0, re.errors[0] || '');
    check('form app entered app-mode (form UI)', re.document.body.classList.contains('app-mode') && re.document.body.classList.contains('form-app'));
  }

  const suiteFailed = failed - before;
  return suiteFailed;
}

// ---- main ----
// Auto-pick the highest c0fi-vX.Y.html in the project root (same as start.sh), so this never
// needs updating on a version bump. Matches ONLY the app file, not c0fi-user-guide-v*.html.
function highestApp(dir) {
  const files = readdirSync(dir).filter(f => /^c0fi-v\d+\.\d+\.html$/.test(f));
  files.sort((a, b) => {
    const [, aM, am] = a.match(/v(\d+)\.(\d+)/), [, bM, bm] = b.match(/v(\d+)\.(\d+)/);
    return (+aM - +bM) || (+am - +bm);
  });
  return files.at(-1) || null;
}
const arg = process.argv[2];
const selfCheck = process.argv.includes('--self-check');
let appPath;
if (arg && !arg.startsWith('--')) {
  appPath = resolve(arg);
} else {
  const root = resolve(HERE, '..');
  const f = highestApp(root);
  if (!f) { console.error('No c0fi-v*.html found in ' + root); process.exit(1); }
  appPath = resolve(root, f);
}

console.log('C0fi smoke test — jsdom headless  (target: ' + appPath.split('/').pop() + ')');
const mainFails = await runSuite(appPath, { expectPass: true });

let selfOk = true;
if (selfCheck) {
  console.log('\n\x1b[1m— self-check: these archived versions have KNOWN bugs and MUST fail —\x1b[0m');
  for (const bad of ['archive/c0fi-v5.3.html', 'archive/c0fi-v5.4.html']) {
    const p = resolve(HERE, '..', bad);
    if (!existsSync(p)) { console.log('  (skip, not found: ' + bad + ')'); continue; }
    const before = { passed, failed };
    const f = await runSuite(p, { expectPass: false });
    if (f === 0) { selfOk = false; console.log('  \x1b[31m✗ SELF-CHECK: ' + bad + ' passed but should have failed!\x1b[0m'); }
    else console.log('  \x1b[32m✓ self-check: ' + bad + ' failed as expected (harness catches the bug)\x1b[0m');
  }
}

console.log('\n' + '─'.repeat(48));
console.log('current app: ' + (mainFails === 0 ? '\x1b[32mALL SMOKE TESTS PASSED\x1b[0m' : '\x1b[31m' + mainFails + ' FAILED\x1b[0m'));
process.exit((mainFails === 0 && selfOk) ? 0 : 1);
