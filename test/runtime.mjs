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

// --- 5. Weekly Auto Brew scheduling math (v6.8) — deterministic: abNextAt takes `now` explicitly ---
{
  const now = new w.Date(2026, 6, 15, 10, 0, 0).getTime();   // fixed local wall-clock; weekday derived below
  const dow = new w.Date(now).getDay();
  // a) selected weekday, time still ahead today -> fires today at that time
  const later = w.abNextAt({ mode: 'weekly', days: [dow], atTime: '23:59' }, now);
  const laterD = new w.Date(later);
  check('weekly: time-still-ahead fires today', laterD.getDay() === dow && laterD.getHours() === 23 && laterD.getMinutes() === 59 && (later - now) < 86400000, laterD.toString());
  // b) selected weekday, time already passed today -> fires same weekday next week (~7 days)
  const next = w.abNextAt({ mode: 'weekly', days: [dow], atTime: '00:01' }, now);
  check('weekly: time-passed rolls to next week', new w.Date(next).getDay() === dow && Math.round((next - now) / 86400000) === 7, new w.Date(next).toString());
  // c) only tomorrow's weekday selected -> fires tomorrow, not today
  const tmr = (dow + 1) % 7;
  const tom = w.abNextAt({ mode: 'weekly', days: [tmr], atTime: '09:00' }, now);
  check('weekly: tomorrow-only fires within 2 days', new w.Date(tom).getDay() === tmr && (tom - now) < 2 * 86400000, new w.Date(tom).toString());
  // d) helpers: normalize, label, describe
  check('abDays dedups + sorts', JSON.stringify(w.abDays({ days: [5, 1, 1, 3] })) === '[1,3,5]');
  check('abDays empty -> every day', JSON.stringify(w.abDays({ days: [] })) === '[0,1,2,3,4,5,6]');
  check('abDaysLabel names selected days', w.abDaysLabel({ days: [1, 3, 5] }) === 'Mon, Wed, Fri');
  check('abDaysLabel all 7 -> "every day"', w.abDaysLabel({ days: [0, 1, 2, 3, 4, 5, 6] }) === 'every day');
  check('abDesc weekly reads days + time', w.abDesc({ mode: 'weekly', days: [1, 3, 5], atTime: '09:30' }) === 'Mon, Wed, Fri at 09:30');
}

// --- 6. Escalate node (v6.9): the honest "I couldn't do this" exit ---
{
  errors.length = 0;
  const { ids, st } = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'PAYLOAD-X' } },                                    // 0
    { type: 'branch', cfg: { js: "return 'FAIL';", branches: 'OK,FAIL' } },                // 1
    { type: 'output', cfg: { label: 'result' } },                                          // 2
    { type: 'escalate', cfg: { reason: 'could not verify: {{input}}', severity: 'blocked' } }, // 3
  ], [[0, 1], [1, 2, 'OK'], [1, 3, 'FAIL']]);
  check('escalate: brew completes without throwing', errors.length === 0, errors[0] || '');
  check('escalate: recorded exactly one escalation', st.escalations.length === 1, JSON.stringify(st.escalations));
  check('escalate: reason interpolates {{input}}', /could not verify: PAYLOAD-X/.test(st.escalations[0]?.reason || ''), st.escalations[0]?.reason);
  check('escalate: severity captured', st.escalations[0]?.severity === 'blocked');
  check('escalate: unreached Output stayed empty', st.nodes[ids[2]].out == null);
  const rep = w.escalationReport();
  check('escalate: report names the node and reason', /ESCALATED TO A HUMAN \(1\)/.test(rep) && /could not verify: PAYLOAD-X/.test(rep), rep);
  // a clean run must reset the ledger — otherwise yesterday's escalation haunts every later brew
  await brewFlow(w, [{ type: 'trigger', cfg: { payload: 'y' } }, { type: 'output', cfg: {} }], [[0, 1]]);
  check('escalate: ledger resets on the next brew', st.escalations.length === 0 && w.escalationReport() === '');
}

// --- 7. HTTP non-2xx (v6.9): a 500 must NOT flow downstream as if it succeeded ---
{
  const realFetch = w.fetch;
  w.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom', json: async () => ({}) });
  errors.length = 0;
  const { ids, st } = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'x' } },                          // 0
    { type: 'http', cfg: { method: 'GET', url: 'http://x.test/a' } },    // 1
    { type: 'code', cfg: { js: "memory.reached=1; return input;" } },    // 2
  ], [[0, 1], [1, 2]]);
  check('http fail: node marked failed on 500', st.nodes[ids[1]].status === 'fail', st.nodes[ids[1]].status);
  check('http fail: downstream never ran on 500', !st.memory.reached);

  // onError:'pass' opts back in to the old behavior for flows that inspect error bodies
  const r2 = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'x' } },                                              // 0
    { type: 'http', cfg: { method: 'GET', url: 'http://x.test/a', onError: 'pass' } },       // 1
    { type: 'code', cfg: { js: "memory.passed=String(input); return input;" } },             // 2
  ], [[0, 1], [1, 2]]);
  check('http pass: error body flows downstream when opted in', r2.st.memory.passed === 'boom', r2.st.memory.passed);

  // and a 200 still works unchanged
  w.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'fine', json: async () => ({}) });
  const r3 = await brewFlow(w, [
    { type: 'trigger', cfg: { payload: 'x' } },
    { type: 'http', cfg: { method: 'GET', url: 'http://x.test/a' } },
  ], [[0, 1]]);
  check('http ok: 2xx unchanged', r3.st.nodes[r3.ids[1]].out === 'fine', String(r3.st.nodes[r3.ids[1]].out));
  w.fetch = realFetch;
}

// --- 8. Auto Brew memory persistence (v6.9): a scheduled flow can accumulate across runs ---
{
  const st = w.__c0fi;
  st.cfg.model = 'test-model';
  const flow = {
    nodes: [
      { id: 't1', type: 'trigger', name: 'T', x: 100, y: 100, cfg: { payload: 'go' } },
      { id: 'c1', type: 'code', name: 'C', x: 300, y: 100, cfg: { js: "memory.count=(+memory.count||0)+1; return memory.count;" } },
      { id: 'o1', type: 'output', name: 'O', x: 500, y: 100, cfg: { label: 'n' } },
    ],
    wires: [{ from: 't1', fromPort: 'out', to: 'c1' }, { from: 'c1', fromPort: 'out', to: 'o1' }],
  };
  const mk = (id, persistMem) => {
    w.localStorage.setItem('c0fi.autobrews', JSON.stringify([{
      id, name: 'T-' + id, mode: 'every', everyMins: '999', atTime: '08:00', days: [],
      paused: true, autoSave: false, persistMem, memory: {}, lastRun: 0, lastStatus: '', lastResult: '', lastEscalations: '', flow,
    }]));
  };
  const entry = () => w.autoBrews()[0];

  // canvas memory the background run must NOT be able to see or clobber
  st.memory = { canvasOnly: 'do-not-touch' };

  mk('abPersist', true);
  await w.runAutoBrew('abPersist', true); await sleep(20);
  const after1 = entry();
  await w.runAutoBrew('abPersist', true); await sleep(20);
  const after2 = entry();
  check('persist on: memory carried to the stored entry', after1.memory?.count === 1, JSON.stringify(after1.memory));
  check('persist on: second run continues from the first', after2.memory?.count === 2, JSON.stringify(after2.memory));
  check('persist on: result reflects accumulation', /2/.test(after2.lastResult || ''), after2.lastResult);
  check('persist on: canvas memory still isolated', st.memory.canvasOnly === 'do-not-touch' && st.memory.count === undefined, JSON.stringify(st.memory));

  mk('abFresh', false);
  await w.runAutoBrew('abFresh', true); await sleep(20);
  await w.runAutoBrew('abFresh', true); await sleep(20);
  const fresh = entry();
  check('persist off: stays stateless, never accumulates', !Object.keys(fresh.memory || {}).length && /1/.test(fresh.lastResult || ''), JSON.stringify(fresh.memory) + ' / ' + fresh.lastResult);

  // an escalating scheduled flow reports escalated, not ok
  const escFlow = { nodes: [
      { id: 't1', type: 'trigger', name: 'T', x: 100, y: 100, cfg: { payload: 'go' } },
      { id: 'e1', type: 'escalate', name: 'E', x: 300, y: 100, cfg: { reason: 'needs a human', severity: 'blocked' } },
    ], wires: [{ from: 't1', fromPort: 'out', to: 'e1' }] };
  w.localStorage.setItem('c0fi.autobrews', JSON.stringify([{
    id: 'abEsc', name: 'E', mode: 'every', everyMins: '999', atTime: '08:00', days: [],
    paused: true, autoSave: false, persistMem: false, memory: {}, lastRun: 0, lastStatus: '', lastResult: '', lastEscalations: '', flow: escFlow,
  }]));
  const ok = await w.runAutoBrew('abEsc', true); await sleep(20);
  const e = entry();
  check('escalating scheduled run is not reported ok', ok === false && /^escalated/.test(e.lastStatus || ''), e.lastStatus);
  check('escalation reason stored on the entry', /needs a human/.test(e.lastEscalations || ''), e.lastEscalations);

  // size guard: an ever-growing append key must not blow the localStorage quota
  st.memory = { big: 'x'.repeat(250000) };
  const snap = w.snapshotMemory();
  check('snapshotMemory clamps an oversized key', snap.big.length < 250000 && snap.big.length > 100000, 'len=' + snap.big.length);
  check('snapshotMemory keeps the newest tail', snap.big.startsWith('…[older entries dropped]…'));

  w.localStorage.removeItem('c0fi.autobrews');
  st.memory = {};
}

// --- 9. Local engine (c0fi_server.py) status light (v6.9) ---
{
  const st = w.__c0fi;
  const realFetch = w.fetch;
  let healthOk = true, healthCalls = 0;
  w.fetch = async (u) => {
    u = String(u);
    if (u.includes('/api/health')) { healthCalls++; if (!healthOk) throw new Error('connection refused'); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }; }
    return realFetch(u);
  };
  await w.testServer();
  check('server light: polls /api/health', healthCalls > 0, 'calls=' + healthCalls);
  check('server light: green when the engine answers', w.document.querySelector('#srvDot').classList.contains('ok'));
  check('server light: label reads online', w.document.querySelector('#srvLabel').textContent === 'server online', w.document.querySelector('#srvLabel').textContent);
  healthOk = false; await w.testServer();
  check('server light: red when nothing is listening', !w.document.querySelector('#srvDot').classList.contains('ok'));
  check('server light: label reads offline', w.document.querySelector('#srvLabel').textContent === 'server offline', w.document.querySelector('#srvLabel').textContent);
  // the help dialog has to carry the actual launch command, incl. a non-default port
  // jsdom ships no working showModal; without a stub this throws, and runtime.mjs's
  // uncaughtException handler swallows it -> the app's setInterval hangs the process forever.
  if (w.HTMLDialogElement) w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  st.cfg.proxy = 'http://localhost:8795'; w.srvHelp();
  check('server light: help shows the launch command with the right port', /python3 c0fi_server\.py 8795/.test(w.document.querySelector('#srvCmd').textContent), w.document.querySelector('#srvCmd').textContent);
  check('server light: offline help explains the fallback', /fall back/i.test(w.document.querySelector('#srvState').innerHTML));
  st.cfg.proxy = 'http://localhost:8790'; healthOk = true; await w.testServer();
  check('server light: recovers to green', w.document.querySelector('#srvDot').classList.contains('ok'));
  w.fetch = realFetch;
}

// --- 10. Orchestrator "working" spinner (v6.9) — a silent 30s model call reads as a hang ---
{
  const t = w.thinkingMsg('building the flow…');
  check('spinner: element rendered', !!t.querySelector('.spinner'));
  check('spinner: shows an elapsed second count', /\d+s/.test(t.textContent), t.textContent);
  check('spinner: repaint timer running', !!t.__timer);
  w.stopThinking(t);
  check('spinner: stopThinking clears the timer', !t.__timer);
  const frozen = t.innerHTML;
  await sleep(1100);
  check('spinner: never repaints over the answer once stopped', t.innerHTML === frozen);
}

// --- 11. Deterministic new-flow gate (v6.9) ---
// The model reliably ignores a prompt rule telling it to clear (measured 0/4), so the decision
// lives in code. A plan that brings its own trigger and touches nothing existing = a new flow.
{
  const st = w.__c0fi;
  const dirty = () => {
    st.nodes = {}; st.wires = []; w.document.querySelector('#nodes').innerHTML = '';
    const t = w.addNode('trigger', 100, 300, { payload: 'x' }, 'Start');
    const h = w.addNode('http', 340, 300, { url: 'http://x' }, 'HTTP GET');
    const c = w.addNode('code', 580, 300, { js: 'return 1;' }, 'Transform');
    st.wires.push({ from: t, fromPort: 'out', to: h }, { from: h, fromPort: 'out', to: c });
    return { t, h, c };
  };
  // exactly what qwen3-coder:30b emits for "build a flow…" — note: no clear_canvas op
  const NEWPLAN = [
    { op: 'add_node', ref: 'a', type: 'trigger', name: 'Trigger', x: 0, y: 0, cfg: { payload: 'go' } },
    { op: 'add_node', ref: 'b', type: 'code', name: 'Transform', x: 240, y: 0, cfg: { js: 'return 2;' } },
    { op: 'add_node', ref: 'c', type: 'output', name: 'count', x: 480, y: 0, cfg: { label: 'count' } },
    { op: 'connect', from: 'a', to: 'b' }, { op: 'connect', from: 'b', to: 'c' },
  ];
  dirty();
  check('gate: recognises an unrelated new flow', w.planIsNewFlow(NEWPLAN));
  await w.applyActions(JSON.parse(JSON.stringify(NEWPLAN)));
  await sleep(30);
  check('gate: old flow replaced and new one fully wired', Object.keys(st.nodes).length === 3 && st.wires.length === 2, Object.keys(st.nodes).length + 'n/' + st.wires.length + 'w');
  check('gate: exactly one trigger left (no orphan)', Object.values(st.nodes).filter(n => n.type === 'trigger').length === 1);
  w.undo(); await sleep(20);
  check('gate: the clear is undoable in one step', Object.values(st.nodes).some(n => n.name === 'HTTP GET'));

  const ids = dirty();
  const EXT = [{ op: 'add_node', ref: 'm', type: 'memory', name: 'Log', x: 800, y: 300, cfg: { mode: 'append', key: 'log' } },
               { op: 'connect', from: ids.c, to: 'm' }];
  check('gate: an extend plan is not a new flow', !w.planIsNewFlow(EXT));
  await w.applyActions(JSON.parse(JSON.stringify(EXT))); await sleep(30);
  check('gate: extending preserves the existing flow', Object.keys(st.nodes).length === 4 && st.wires.length === 3, Object.keys(st.nodes).length + 'n/' + st.wires.length + 'w');

  dirty();
  check('gate: a plan with no trigger of its own never clears', !w.planIsNewFlow([{ op: 'add_node', ref: 'x', type: 'code', name: 'C', x: 0, y: 0, cfg: { js: 'return 1;' } }]));
  st.nodes = {}; st.wires = []; w.document.querySelector('#nodes').innerHTML = '';
  check('gate: empty canvas is never a clear', !w.planIsNewFlow(NEWPLAN));
  dirty();
  await w.applyActions(JSON.parse(JSON.stringify(NEWPLAN)), { noClear: true }); await sleep(30);
  check('gate: refine mode never clears, even on a new-flow-shaped plan', Object.keys(st.nodes).length === 6, String(Object.keys(st.nodes).length));
}

// --- 12. Deterministic chain fallback (v6.9) ---
// Measured: ~1 in 6 builds comes back with add_node ops and NO connects. The old path asked the
// same model to fix its own wiring, and when that failed too the user got a canvas of red nodes.
// (autoWire's model call fails naturally here — the boot fetch mock returns no message.content.)
{
  const st = w.__c0fi;
  const reset = () => { st.nodes = {}; st.wires = []; w.document.querySelector('#nodes').innerHTML = ''; };
  const chatText = () => w.document.querySelector('#chatLog').textContent;

  reset();
  await w.applyActions([
    { op: 'add_node', ref: 'a', type: 'trigger', name: 'Start', x: 0, y: 100, cfg: { payload: 'x' } },
    { op: 'add_node', ref: 'b', type: 'llm', name: 'Draft', x: 240, y: 100, cfg: { prompt: '{{input}}' } },
    { op: 'add_node', ref: 'c', type: 'critic', name: 'Gate', x: 480, y: 100, cfg: { goal: 'x' } },
    { op: 'add_node', ref: 'd', type: 'memory', name: 'Archive', x: 720, y: 100, cfg: { mode: 'write', key: 'k' } },
  ]);
  await sleep(60);
  check('chain: recovers a build that emitted zero connects', st.wires.length === 3, st.wires.length + ' wires');
  const order = st.wires.map(x => st.nodes[x.from].name + '->' + st.nodes[x.to].name).join(', ');
  check('chain: wires in left-to-right layout order', order === 'Start->Draft, Draft->Gate, Gate->Archive', order);
  check('chain: says the order was inferred, not known', /left-to-right/.test(chatText()));
  const hasIn = new Set(st.wires.map(x => x.to));
  check('chain: leaves nothing orphaned', Object.values(st.nodes).filter(n => n.type !== 'trigger' && !hasIn.has(n.id)).length === 0);

  // a fan-out is a real choice — guessing one branch silently drops the other and looks finished
  reset();
  await w.applyActions([
    { op: 'add_node', ref: 'a', type: 'trigger', name: 'T', x: 0, y: 100, cfg: {} },
    { op: 'add_node', ref: 'b', type: 'decision', name: 'Gate', x: 240, y: 100, cfg: { question: '{{input}}', branches: 'A,B' } },
    { op: 'add_node', ref: 'c', type: 'output', name: 'Yes', x: 480, y: 40, cfg: {} },
    { op: 'add_node', ref: 'd', type: 'output', name: 'No', x: 480, y: 200, cfg: {} },
  ]);
  await sleep(60);
  check('chain: never guesses a decision branch', st.wires.filter(x => st.nodes[x.from].type === 'decision').length === 0);
  check('chain: still flags what it refused to guess', /needs a wire|Couldn/i.test(chatText()));

  // and it must not touch a build the model wired correctly itself
  reset();
  await w.applyActions([
    { op: 'add_node', ref: 'a', type: 'trigger', name: 'T', x: 0, y: 100, cfg: {} },
    { op: 'add_node', ref: 'b', type: 'llm', name: 'L', x: 240, y: 100, cfg: { prompt: '{{input}}' } },
    { op: 'add_node', ref: 'c', type: 'output', name: 'O', x: 480, y: 100, cfg: {} },
    { op: 'connect', from: 'a', to: 'b' }, { op: 'connect', from: 'b', to: 'c' },
  ]);
  await sleep(60);
  check('chain: leaves a correctly-wired build untouched', st.wires.length === 2, st.wires.length + ' wires');
  check('chain: strictly left-to-right, so never a cycle', !st.wires.some(x => st.nodes[x.from].x >= st.nodes[x.to].x));
}

console.log('\n' + '─'.repeat(48));
console.log(failed === 0 ? '\x1b[32mALL RUNTIME TESTS PASSED\x1b[0m' : '\x1b[31m' + failed + ' FAILED\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
