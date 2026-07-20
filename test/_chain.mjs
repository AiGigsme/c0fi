import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let p=0,f=0; const ck=(n,c,d='')=>{c?(p++,console.log('  \x1b[32m✓\x1b[0m '+n)):(f++,console.log('  \x1b[31m✗ '+n+'\x1b[0m'+(d?' — '+d:'')));};
const errs=[]; const vc=new VirtualConsole(); vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(readFileSync('../c0fi-v6.9.html','utf8'),{runScripts:'dangerously',virtualConsole:vc,url:'http://localhost/',
  beforeParse(w){w.onerror=m=>errs.push(m); w.alert=()=>{}; w.confirm=()=>true;
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    // autoWire's model call returns nothing usable -> forces the deterministic fallback
    w.fetch=async(u)=>({ok:true,status:200,json:async()=>({models:[{name:'m'}],message:{content:'{"actions":[]}'}}),text:async()=>'{}'});}});
await sleep(250);
const w=dom.window, st=w.__c0fi; st.cfg.model='m';

console.log('\nDeterministic chain fallback');
// exactly the user's failure: 3 nodes added, zero connects emitted
st.nodes={}; st.wires=[]; w.document.querySelector('#nodes').innerHTML='';
await w.applyActions([
 {op:'add_node',ref:'a',type:'trigger',name:'Start',x:0,y:100,cfg:{payload:'x'}},
 {op:'add_node',ref:'b',type:'llm',name:'Search Topic',x:240,y:100,cfg:{prompt:'{{input}}'}},
 {op:'add_node',ref:'c',type:'llm',name:'Pick Best URL',x:480,y:100,cfg:{prompt:'{{input}}'}}]);
await sleep(60);
ck('chains a fully unwired linear build', st.wires.length===2, st.wires.length+' wires');
const order=st.wires.map(x=>st.nodes[x.from].name+'->'+st.nodes[x.to].name).join(', ');
ck('chains in left-to-right layout order', order==='Start->Search Topic, Search Topic->Pick Best URL', order);
ck('tells the user it guessed the order', /left-to-right/.test(w.document.querySelector('#chatLog').textContent));

// a decision's fan-out must NOT be guessed
st.nodes={}; st.wires=[]; w.document.querySelector('#nodes').innerHTML='';
await w.applyActions([
 {op:'add_node',ref:'a',type:'trigger',name:'T',x:0,y:100,cfg:{}},
 {op:'add_node',ref:'b',type:'decision',name:'Gate',x:240,y:100,cfg:{question:'{{input}}',branches:'A,B'}},
 {op:'add_node',ref:'c',type:'output',name:'Yes',x:480,y:40,cfg:{}},
 {op:'add_node',ref:'d',type:'output',name:'No',x:480,y:200,cfg:{}}]);
await sleep(60);
const fromGate=st.wires.filter(x=>st.nodes[x.from].type==='decision').length;
ck('never guesses a decision branch', fromGate===0, fromGate+' wires from the decision');
ck('still flags what it would not guess', /needs a wire|Couldn/i.test(w.document.querySelector('#chatLog').textContent));

// must not disturb a build the model wired correctly
st.nodes={}; st.wires=[]; w.document.querySelector('#nodes').innerHTML='';
await w.applyActions([
 {op:'add_node',ref:'a',type:'trigger',name:'T',x:0,y:100,cfg:{}},
 {op:'add_node',ref:'b',type:'llm',name:'L',x:240,y:100,cfg:{prompt:'{{input}}'}},
 {op:'add_node',ref:'c',type:'output',name:'O',x:480,y:100,cfg:{}},
 {op:'connect',from:'a',to:'b'},{op:'connect',from:'b',to:'c'}]);
await sleep(60);
ck('leaves a correctly-wired build untouched', st.wires.length===2, st.wires.length+' wires');
// no cycles, ever
ck('introduces no cycle', !st.wires.some(x=>st.nodes[x.from].x >= st.nodes[x.to].x));
console.log('\nerrors: '+(errs.length?errs[0]:'none'));
console.log('\n'+(f===0?'\x1b[32mALL '+p+' CHAIN TESTS PASSED\x1b[0m':'\x1b[31m'+f+' FAILED\x1b[0m'));
process.exit(f?1:0);
