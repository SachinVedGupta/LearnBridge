import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mountRemoteUI} from '../apps/local/public/remote.js';

// Executes shipped DOM handlers and asynchronous ordering. This stand-in does
// not establish browser layout, phone device compatibility or live relay auth.
class Node{
 constructor(tag,cls='',text=''){Object.assign(this,{tagName:tag,className:cls,text,children:[],listeners:new Map(),hidden:false,disabled:false,checked:false,value:''});this.classList={toggle(){}};}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;this.text='';}
 setAttribute(){}
 addEventListener(type,callback){this.listeners.set(type,[...(this.listeners.get(type)||[]),callback]);}
 get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
 set textContent(value){this.text=String(value);this.children=[];}
}
const walk=node=>[node,...node.children.flatMap(walk)],fire=(node,type='click')=>{for(const fn of node.listeners.get(type)||[])fn({preventDefault(){}});};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ids={binding:randomUUID(),grant:randomUUID(),job:randomUUID(),writing:randomUUID(),preview:randomUUID()},expiry=new Date(Date.now()+600000).toISOString();
const preview={preview_id:ids.preview,preview:{policy:{binding_id:ids.binding,writing_record:{id:ids.writing,revision:2},result_sha256:'a'.repeat(64),expires_at:expiry},review_hash:'b'.repeat(64),text:'<script>REMOTE_LITERAL_SOURCE_CANARY</script>',disclosure:'Separate plaintext relay permission; 24-hour retention.'}};
function harness(t,{intercept,confirm=async()=>true,paired=true,enabled=true}={}){
 const root=new Node('main'),jobs=[],calls=[],timers=new Map();let actual={enabled,paired,permission_current:paired,native_available:true,native_execution:false,binding_id:paired?ids.binding:null};
 const previousSet=globalThis.setTimeout,previousClear=globalThis.clearTimeout;let timer=0;globalThis.setTimeout=callback=>{const id=++timer;timers.set(id,callback);return id;};globalThis.clearTimeout=id=>timers.delete(id);
 const ui=mountRemoteUI({root,element:(tag,cls,text)=>new Node(tag,cls,text),request:async(path,options={})=>{calls.push({path,...options});const custom=intercept?.(path,options);if(custom!==undefined)return await custom;
  if(path==='/remote/status')return structuredClone(actual);if(path==='/remote/jobs')return {items:paired?[{job_id:ids.job,state:'awaiting_student'}]:[]};if(path==='/remote/results')return options.method==='POST'?{item:{state:'reviewed'}}:{items:[]};
  if(path==='/writing/items')return {items:[{id:ids.writing,title:'Reviewed writing',revision:2,payload_hash:'c'.repeat(64),state:'accepted',stale:false}]};if(path==='/agent-grants')return {items:[{id:ids.grant,destination:'codex',state:'active',expires_at:expiry}]};
  if(path==='/remote/pair'){paired=true;actual={...actual,paired:true,permission_current:true,binding_id:ids.binding};return actual;}if(path==='/remote/results/preview')return structuredClone(preview);
  if(path==='/remote/poll')return {request:{state:'idle'},native:{state:'unavailable'}};if(path==='/remote/delivery/poll')return {state:'idle'};if(path==='/remote/unpair'){paired=false;actual={...actual,paired:false,permission_current:false,binding_id:null};return {acknowledged:true};}throw Error('Unexpected remote UI fixture route');},
  busy(control,callback){control.disabled=true;const job=Promise.resolve().then(callback).finally(()=>{control.disabled=false;});jobs.push(job);return job;},confirmAction:confirm,navigate:()=>{}});
 t.after(()=>{ui.reset();globalThis.setTimeout=previousSet;globalThis.clearTimeout=previousClear;});
 const button=label=>{const node=walk(root).find(node=>node.tagName==='button'&&node.textContent===label);assert(node,label);return node;},field=n=>walk(root).find(node=>node.id===`remote-field-${n}`);
 return {root,ui,calls,timers,button,field,start(label){fire(button(label));return jobs.at(-1);},async click(label){fire(button(label));await jobs.at(-1)?.catch(()=>{});await Promise.resolve();},choose(){field(4).value=ids.job;field(5).value=ids.writing;},setStatus:value=>{actual=value;}};
}
test('RUI01: disabled refresh has no pairing/polling/host/upload side effects and no private controls are enabled',async t=>{
 const h=harness(t,{enabled:false,paired:false});await h.ui.refresh();assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.equal(h.field(3).checked,false);
 for(const label of ['Review and pair phone','Check phone messages','Start foreground polling','Preview exact text and relay permission','Unpair phone and stop future requests'])assert.equal(h.button(label).disabled,true);
});
test('RUI02: current source grant/native choice cannot change during pairing confirmation; pair is explicit and never starts polling',async t=>{
 const entered=deferred(),release=deferred(),h=harness(t,{paired:false,confirm:()=>{entered.resolve();return release.promise;}});await h.ui.refresh();h.field(1).value=JSON.stringify({pending_id:randomUUID(),challenge:'a'.repeat(32)});h.field(2).value=ids.grant;
 const pending=h.start('Review and pair phone');await entered.promise;h.field(2).value=randomUUID();release.resolve(true);await pending;assert.equal(h.calls.some(call=>call.path==='/remote/pair'),false);assert.equal(h.calls.some(call=>call.path==='/remote/poll'),false);
});
test('RUI03: literal exact text preview has separate confirmation; changing selection during confirmation refuses approval',async t=>{
 const entered=deferred(),release=deferred(),h=harness(t,{confirm:()=>{entered.resolve();return release.promise;}});await h.ui.refresh();h.choose();await h.click('Preview exact text and relay permission');
 assert.equal(walk(h.root).some(node=>node.tagName==='script'),false);assert.equal(walk(h.root).find(node=>node.tagName==='pre').textContent,preview.preview.text);assert.equal(h.calls.some(call=>call.path==='/remote/results'&&call.method==='POST'),false);
 const pending=h.start('Approve this exact response for the relay');await entered.promise;h.field(5).value='';fire(h.field(5),'change');release.resolve(true);await pending;assert.equal(h.calls.some(call=>call.path==='/remote/results'&&call.method==='POST'),false);
});
test('RUI06: replacing the phone code during confirmation cannot enroll the previously displayed phone account',async t=>{
 const entered=deferred(),release=deferred(),h=harness(t,{paired:false,confirm:()=>{entered.resolve();return release.promise;}});await h.ui.refresh();h.field(1).value=JSON.stringify({pending_id:randomUUID(),challenge:'a'.repeat(32)});h.field(2).value=ids.grant;
 const pending=h.start('Review and pair phone');await entered.promise;h.field(1).value=JSON.stringify({pending_id:randomUUID(),challenge:'b'.repeat(32)});release.resolve(true);await pending;assert.equal(h.calls.some(call=>call.path==='/remote/pair'),false);
});
test('RUI04: reset while preview awaits cannot repopulate its private text or reenable its stale action after busy cleanup',async t=>{
 const entered=deferred(),release=deferred(),h=harness(t,{intercept:path=>path==='/remote/results/preview'?(entered.resolve(),release.promise):undefined});await h.ui.refresh();h.choose();const pending=h.start('Preview exact text and relay permission');await entered.promise;h.ui.reset();release.resolve(structuredClone(preview));await pending;await Promise.resolve();
 assert(!h.root.textContent.includes('REMOTE_LITERAL_SOURCE_CANARY'));assert.equal(h.button('Preview exact text and relay permission').disabled,true);assert.equal(h.field(1).value,'');assert.equal(h.calls.some(call=>call.path==='/remote/results'&&call.method==='POST'),false);
});
test('RUI05: pause during foreground poll prevents late polling from scheduling another run; unpair clears private text',async t=>{
 const entered=deferred(),release=deferred(),h=harness(t,{intercept:path=>path==='/remote/poll'?(entered.resolve(),release.promise):undefined});await h.ui.refresh();const pending=h.start('Start foreground polling');await entered.promise;fire(h.button('Pause polling'));release.resolve({request:{state:'idle'},native:{state:'unavailable'}});await pending;await Promise.resolve();assert.equal(h.timers.size,0);
 h.choose();await h.click('Preview exact text and relay permission');assert(h.root.textContent.includes('REMOTE_LITERAL_SOURCE_CANARY'));await h.click('Unpair phone and stop future requests');assert(!h.root.textContent.includes('REMOTE_LITERAL_SOURCE_CANARY'));assert.equal(h.button('Start foreground polling').disabled,true);assert.equal(h.button('Review and pair phone').disabled,false);
});
test('RUI07: hidden document, navigation and pagehide pause polling, clear previews, and require an explicit restart',async t=>{
 const previousDocument=globalThis.document,previousWindow=globalThis.window,document=new Node('document'),window=new Node('window');
 globalThis.document=document;globalThis.window=window;t.after(()=>{globalThis.document=previousDocument;globalThis.window=previousWindow;});
 const h=harness(t);await h.ui.refresh();h.choose();await h.click('Preview exact text and relay permission');h.field(1).value='PRIVATE_PAIR_CODE';
 await h.click('Start foreground polling');assert.equal(h.timers.size,1);document.hidden=true;fire(document,'visibilitychange');
 assert.equal(h.timers.size,0);assert(!h.root.textContent.includes('REMOTE_LITERAL_SOURCE_CANARY'));assert.equal(h.field(1).value,'');
 document.hidden=false;fire(document,'visibilitychange');assert.equal(h.timers.size,0);
 await h.click('Start foreground polling');const before=h.calls.filter(row=>row.path==='/remote/poll').length;h.root.hidden=true;await [...h.timers.values()][0]();
 assert.equal(h.timers.size,0);assert.equal(h.calls.filter(row=>row.path==='/remote/poll').length,before);
 h.root.hidden=false;await h.click('Start foreground polling');assert.equal(h.timers.size,1);fire(window,'pagehide');assert.equal(h.timers.size,0);
});
