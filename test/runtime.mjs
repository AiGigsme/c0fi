// C0fi runtime test — actually BREWS flows in jsdom (no Ollama needed; uses code nodes only).
// Covers the v6.1 engine changes the boot-only smoke test can't see:
//   1. Gather node joins parallel producers into ONE array, firing its downstream once.
//   2. The default "Count + Code Branch" fan-in idiom still runs a node once PER incoming wire
//      (i.e. no accidental dedup slipped in — the bench/self-consistency demos depend on this).
//   3. Undo / redo round-trips a graph mutation.
//
// Usage:  node runtime.mjs [path-to-app.html]      (default: highest ../c0fi-v*.html)
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function highestApp(dir) {
  const files = readdirSync(dir).filter(f => /^c0fi-v\d+\.\d+\.html$/.test(f));
  files.sort((a, b) => { const [, aM, am] = a.match(/v(\d+)\.(\d+)/), [, bM, bm] = b.match(/v(\d+)\.(\d+)/); return (+aM - +bM) || (+am - +bm); });
  return files.at(-1);
}
const arg = process.argv[2];
const appPath = arg ? resolve(arg) : resolve(HERE, '..', highestApp(resolve(HERE, '..')));

let currentErrors = [];
process.on('uncaughtException', e => currentErrors.push('uncaught: ' + (e && e.message || e)));
process.on('unhandledRejection', e => currentErrors.push('unhandledRejection: ' + (e && e.reason?.message || e)));

async function boot() {
  const errors = []; currentErrors = errors;
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message || String(e)));
  const dom = new JSDOM(readFileSync(appPath, 'utf8'), {
    runScripts: 'dangerously', virtualConsole: vc, url: 'http://localhost/',
    beforeParse(w) {
      w.onerror = m => errors.push('onerror: ' + m);
      w.confirm = () => true; w.prompt = () => 'x'; w.alert = () => {};
      w.fetch = async (u) => ({ ok: true, json: async () => (String(u).includes('/api/tags') ? { models: [{ name: 'test-model' }] } : {}), text: async () => '{}', body: null });
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    },
  });
  await sleep(60);
  return { w: dom.window, errors };
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') { if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); } else { failed++; console.log('  \x1b[31m✗ ' + name + '\x1b[0m' + (detail ? '  — ' + detail : '')); } }

// build a graph from a compact spec, wiring by index, then brew to completion
async function brewFlow(w, nodes, wires) {
  const st = w.__c0fi;
  st.nodes = {}; st.wires = []; st.memory = {}; st.cfg.model = 'test-model';
  w.document.querySelector('#nodes').innerHTML = '';
  const ids = nodes.map(n => w.addNode(n.type, n.x || 100, n.y || 100, n.cfg || {}, n.name));
  wires.forEach(([f, t, port]) => st.wires.push({ from: ids[f], fromPort: port || 'out', to: ids[t] }));
  await w.brew();
  await sleep(20);
  return { ids, st };
}

console.log('C0fi runtime test — jsdom brew  (target: ' + appPath.split('/').pop() + ')\n');
const { w, errors } = await boot();
check('app boots clean', errors.length === 0, errors[0] || '');

// --- 1. Gather: two parallel code producers -> Gather -> Output. Output must get ONE array [A,B]. ---
{
  errors.length = 0;
  const { ids, st } = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'x' } },                                   // 0
    { type: 'code', cfg: { js: "return 'A';" } },                                 // 1
    { type: 'code', cfg: { js: "return 'B';" } },                                 // 2
    { type: 'gather' },                                                           // 3
    { type: 'code', cfg: { js: "memory.oRuns=(memory.oRuns||0)+1; return input;" } }, // 4
  ], [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]]);
  const gOut = st.nodes[ids[3]].out;
  const oOut = st.nodes[ids[4]].out;
  check('brew ran without error', errors.length === 0, errors[0] || '');
  check('Gather output is an array of both inputs', Array.isArray(gOut) && gOut.length === 2 && ['A', 'B'].every(x => gOut.includes(x)), JSON.stringify(gOut));
  check('Gather fired its downstream exactly once', st.memory.oRuns === 1, 'oRuns=' + st.memory.oRuns);
  check('downstream received the joined array', Array.isArray(oOut) && oOut.length === 2, JSON.stringify(oOut));
}

// --- 2. Default fan-in idiom preserved: a plain node reached by 2 wires still runs TWICE. ---
{
  const { st } = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'x' } },                                   // 0
    { type: 'code', cfg: { js: "return 'A';" } },                                 // 1
    { type: 'code', cfg: { js: "return 'B';" } },                                 // 2
    { type: 'code', cfg: { js: "memory.n=(memory.n||0)+1; return String(memory.n);" } }, // 3 (counter join)
  ], [[0, 1], [0, 2], [1, 3], [2, 3]]);
  check('fan-in counter node ran once per incoming wire (idiom intact)', st.memory.n === 2, 'memory.n=' + st.memory.n);
}

// --- 3. Undo / redo round-trip a mutation ---
{
  const st = w.__c0fi;
  st.nodes = {}; st.wires = []; st.memory = {}; w.document.querySelector('#nodes').innerHTML = '';
  w.pushUndo();
  const id = w.addNode('llm', 100, 100, {}, 'X');
  const added = !!st.nodes[id];
  w.undo();
  const goneAfterUndo = !st.nodes[id];
  w.redo();
  const backAfterRedo = !!st.nodes[id];
  check('node present after add', added);
  check('undo removes the added node', goneAfterUndo);
  check('redo restores it', backAfterRedo);
}

// --- 4. Focus-mode chat surfacing: a waiting Interaction node floats a reply bar on the canvas ---
{
  const st = w.__c0fi;
  st.nodes = {}; st.wires = []; w.document.querySelector('#nodes').innerHTML = '';
  const cid = w.addNode('chat', 100, 100, { greeting: 'hi' }, 'C');
  w.document.querySelector('#app').classList.add('no-right');   // simulate focus mode (panel hidden)
  const p = w.awaitUserChat('your turn', cid);
  await sleep(5);
  check('focus mode: floating reply bar appears when a chat waits', w.document.querySelector('#canvasChat').classList.contains('on'));
  check('waiting chat node shows the awaiting badge', st.nodes[cid].status === 'awaiting');
  w.document.querySelector('#canvasChatInput').value = 'hello back';
  w.document.querySelector('#canvasChatSend').click();
  const reply = await p;
  check('canvas reply resolves the waiting chat', reply === 'hello back');
  check('floating bar hides after sending', !w.document.querySelector('#canvasChat').classList.contains('on'));
  w.document.querySelector('#app').classList.remove('no-right');
}

console.log('\n' + '─'.repeat(48));
console.log(failed === 0 ? '\x1b[32mALL RUNTIME TESTS PASSED\x1b[0m' : '\x1b[31m' + failed + ' FAILED\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
