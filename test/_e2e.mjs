import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const adds=JSON.parse(readFileSync('/tmp/plan_nowire.json','utf8'));
const errs=[]; const vc=new VirtualConsole(); vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(readFileSync('../c0fi-v6.9.html','utf8'),{runScripts:'dangerously',virtualConsole:vc,url:'http://localhost/',
  beforeParse(w){w.onerror=m=>errs.push(m); w.alert=()=>{}; w.confirm=()=>true;
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    w.fetch=async()=>({ok:true,status:200,json:async()=>({models:[{name:'m'}],message:{content:'{"actions":[]}'}}),text:async()=>'{}'});}});
await sleep(250);
const w=dom.window, st=w.__c0fi; st.cfg.model='m';
await w.applyActions(adds); await sleep(80);
const names=Object.values(st.nodes).sort((a,b)=>a.x-b.x).map(n=>n.name);
console.log('nodes:', names.join(' | '));
console.log('wires:', st.wires.map(x=>st.nodes[x.from].name+' -> '+st.nodes[x.to].name).join('\n       '));
const hasIn=new Set(st.wires.map(x=>x.to));
const orphans=Object.values(st.nodes).filter(n=>n.type!=='trigger'&&!hasIn.has(n.id)).map(n=>n.name);
console.log('\nstill unwired:', orphans.length?orphans.join(', '):'none');
console.log('runnable end-to-end:', orphans.length===0 ? 'YES' : 'NO');
