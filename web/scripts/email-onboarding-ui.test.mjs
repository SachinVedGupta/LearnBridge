import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '@learnbridge/local-storage';
import { createCloudOnboardingRoutes } from '../apps/local-runtime/src/cloud-onboarding-routes.mjs';
import { mountCloudOnboardingUI } from '../apps/local/public/cloud-onboarding.js';
import ts from 'typescript';
import { createCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';

// Exercise the shipped TSX event handlers with persistent React refs, effect
// cleanup, browser API boundaries and controllable async work. This proves file
// preparation and consent sequencing, not that a browser saved a file to disk.
const STUDENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'ca_synthetic_student';
const DOC = '19b11732c1b578f0';
const LINK = `https://docs.google.com/document/d/${DOC}/edit`;
const NOW = Date.parse('2026-10-04T15:00:00.000Z');
const ARM = 'Download reviewed email bundle';
const CONFIRM = 'Confirm private download';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const walk = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
const text = value => value === null || value === undefined || value === false ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? text(value.props?.children) : String(value);
function bundle(body = 'Literal reviewed synthetic email. Café λ <script>doNotRun()</script>') {
  return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 2, origin: 'https://learnbridge.example', owner: { student_id: STUDENT, verification: 'supabase_session_at_fetch' }, provider: 'gmail', account_id: ACCOUNT, academic_policy: 'learning_support', retrieved_at: new Date(NOW).toISOString(),
    records: [{ id: DOC, title: 'Synthetic selected email', url: null, modified_at: null, text: body, sha256: createHash('sha256').update(body).digest('hex'), coverage: 'partial_text', limitations: ['Partial synthetic plaintext only.'],
      source_metadata: { kind: 'email', message_id: DOC, thread_id: '19b11732c1b57000', from: 'course@example.test', to: 'student@example.test', date_header: 'Tue, 15 Sep 2026 14:00:00 +0000', sent_at: '2026-09-15T14:00:00.000Z', received_at: null, provider_timestamp: '2026-09-15T14:00:00Z', timestamp_semantics: 'provider_reported_unverified', selected_scope: { folder: 'INBOX', start_date: '2026-09-01', end_date: '2026-09-30', subject_phrase: 'Lecture' } } }], limitations: ['No model access or source write.'] });
}
const makePreview = (selected, token = 'synthetic_opaque_review_token') => ({ bundle: selected, review_hash: selected.bundle_hash, preview_token: token, expires_at: new Date(NOW + 300000).toISOString() });

async function harness(t, mode = 'normal') {
  const selected = bundle(), preview = makePreview(selected), replacement = makePreview(bundle('A separately fetched synthetic preview.'), 'synthetic_replacement_token');
  const accounts = [{ id: ACCOUNT, provider: 'gmail', label: 'Selected synthetic Gmail account' }, { id: 'ca_synthetic_other', provider: 'gmail', label: 'Other synthetic owned account' }];
  const row = { id: DOC, title: 'Synthetic selected email', thread_id: '19b11732c1b57000', from: 'course@example.test', to: 'student@example.test', provider_timestamp: '2026-09-15T14:00:00Z', selection_token: 'synthetic_selection_token' };
  // Existing component hook positions are preserved; the last state is the new
  // confirmation panel. Startup account hydration is fulfilled synthetically.
  const values = mode === 'empty' ? [] : [accounts, ACCOUNT, 'Lecture', 'INBOX', '2026-09-01', '2026-09-30', 'learning_support', [row], new Set([DOC]), preview, true, '', '', '', true, null];
  const refs = [], effects = [], pendingEffects = [], calls = [], blobs = [], downloads = [], revoked = [], timers = new Map();
  const exportStarted = deferred(), releaseExport = deferred(), hashStarted = deferred(), releaseHash = deferred();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, timerId = 0, now = NOW, hashes = 0, nativeConfirms = 0, mounted = true, disposed = false, writesAfterUnmount = 0, tree;
  const react = {
    useState(initial) {
      const own = stateIndex++;
      if (!(own in values)) values[own] = typeof initial === 'function' ? initial() : initial;
      return [values[own], value => { if (!mounted) writesAfterUnmount++; values[own] = typeof value === 'function' ? value(values[own]) : value; }];
    },
    useRef(initial) { const own = refIndex++; if (!(own in refs)) refs[own] = { current: initial }; return refs[own]; },
    useEffect(callback, dependencies) {
      const own = effectIndex++, previous = effects[own];
      if (!previous || !dependencies || dependencies.length !== previous.dependencies?.length || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        pendingEffects.push({ own, callback, dependencies });
      }
    },
  };
  const source = readFileSync(new URL('../apps/web/src/app/onboarding/email/email-onboarding-client.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    throw Error(`Unexpected confirmation component dependency: ${name}`);
  }, module, module.exports);
  const original = Object.fromEntries(['window', 'document', 'fetch', 'crypto', 'setTimeout', 'clearTimeout'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalNow = Date.now;
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  define('window', { confirm() { nativeConfirms++; throw Error('Native confirmation must never be used.'); } });
  define('document', { createElement(tag) { assert.equal(tag, 'a'); const anchor = { click() { downloads.push({ href: anchor.href, filename: anchor.download }); } }; return anchor; } });
  define('fetch', async (path, options) => {
    assert.ok(path.startsWith('/api/email-onboarding/'), 'The component may call only its synthetic same-origin source API.');
    const action = path.slice('/api/email-onboarding/'.length); calls.push({ action, path, ...options });
    let result;
    if (action === 'accounts') result = { items: accounts, coverage: 'account_metadata_only' };
    else if (action === 'export') {
      exportStarted.resolve(); if (mode === 'network') await releaseExport.promise;
      const input = JSON.parse(options.body), source = input.preview_token === replacement.preview_token ? replacement.bundle : selected;
      result = { bundle: structuredClone(source), sharing: 'not_granted', filename: 'LearnBridge-selected-gmail.json' };
    } else if (action === 'preview' || action === 'preview_link') result = replacement;
    else if (action === 'search') result = { items: [row], coverage: 'partial', unexpected_content_bytes: 0 };
    if (mode === 'corrupted' && action === 'export') result.bundle.records[0].text += ' changed';
    else if (!['accounts','export','preview','preview_link','search'].includes(action)) assert.fail(`No synthetic API action is allowed for this test: ${action}`);
    return { ok: true, json: async () => result };
  });
  define('crypto', { subtle: { async digest(algorithm, input) {
    assert.equal(algorithm, 'SHA-256'); const bytes = createHash('sha256').update(input).digest();
    if (++hashes === 1 && mode === 'hash') { hashStarted.resolve(); await releaseHash.promise; }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } } });
  define('setTimeout', (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; });
  define('clearTimeout', id => { timers.delete(id); });
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob); return `blob:synthetic-reviewed-download-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  Date.now = () => now;

  function render() {
    assert.equal(mounted, true, 'An unmounted component may not be rendered again.');
    stateIndex = 0; refIndex = 0; effectIndex = 0; tree = module.exports.default();
    for (const effect of pendingEffects.splice(0)) {
      effects[effect.own]?.cleanup?.();
      effects[effect.own] = { dependencies: effect.dependencies, cleanup: effect.callback() };
    }
    return tree;
  }
  function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const effect of effects.toReversed()) effect?.cleanup?.();
  }
  function dispose() {
    if (disposed) return;
    unmount(); releaseExport.resolve(); releaseHash.resolve(); disposed = true;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; Date.now = originalNow;
    for (const [name, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
  t.after(dispose);
  function button(label) { const found = walk(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, `Expected visible button: ${label}`); return found; }
  function field(label, tag = 'input') { const parent = walk(tree).find(node => node.type === 'label' && text(node).startsWith(label)); const found = parent && walk(parent).find(node => node.type === tag); assert.ok(found, `Expected field: ${label}`); return found; }
  const review = () => field(' I reviewed every selected text');
  function setReview(checked) { review().props.onChange({ target: { checked } }); }
  function dialog() { return walk(tree).find(node => node.props?.role === 'dialog'); }
  function arm() { const control = button(ARM); assert.equal(Boolean(control.props.disabled), false); control.props.onClick(); render(); assert.ok(dialog(), 'The first click must arm the in-app review panel.'); return button(CONFIRM).props.onClick; }
  async function flush() { await settle(); if (mounted) render(); await settle(); if (mounted) render(); }
  render(); await flush(); calls.length = 0;
  return {
    selected, preview, replacement, values, refs, calls, blobs, downloads, revoked, timers, exportStarted, releaseExport, hashStarted, releaseHash,
    render, flush, dispose, unmount, button, field, review, setReview, arm, dialog,
    exports: () => calls.filter(call => call.action === 'export'),
    get hashes() { return hashes; }, get nativeConfirms() { return nativeConfirms; }, get writesAfterUnmount() { return writesAfterUnmount; },
    advance(ms) { now += ms; },
    fireExpiry() { const found = [...timers].find(([, timer]) => timer.delay >= 300000); assert.ok(found, 'The actual preview expiry effect must register a timer.'); timers.delete(found[0]); found[1].callback(); },
  };
}

function noDownload(h) { assert.equal(h.blobs.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.nativeConfirms, 0); }

test('EUI01 account/folder/dates/phrase and message checkboxes start empty; source reads require exact student choices',async t=>{
 const h=await harness(t,'empty');assert.equal(h.field('Connected Gmail account','select').props.value,'');assert.equal(h.field('Folder','select').props.value,'');assert.equal(h.button('Search selected email metadata').props.disabled,true);assert.equal(h.button('Read only checked messages').props.disabled,true);assert.equal(h.calls.length,0);
 for(const [label,tag,value]of [['Connected Gmail account','select',ACCOUNT],['Folder','select','INBOX'],['Start UTC date','input','2026-09-01'],['End UTC date','input','2026-09-30'],['Subject phrase','input','Lecture']]){h.field(label,tag).props.onChange({target:{value}});h.render()}
 h.button('Search selected email metadata').props.onClick();await h.flush();assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(h.calls[0].body),{account_id:ACCOUNT,scope:{folder:'INBOX',start_date:'2026-09-01',end_date:'2026-09-30',subject_phrase:'Lecture'}});assert.equal(h.values[8].size,0);assert.equal(h.button('Read only checked messages').props.disabled,true);
 h.field(' Synthetic selected email').props.onChange({target:{checked:true}});h.render();h.button('Read only checked messages').props.onClick();await h.flush();assert.deepEqual(JSON.parse(h.calls[1].body),{account_id:ACCOUNT,selection_tokens:['synthetic_selection_token'],academic_policy:'learning_support'});assert.equal(h.values[10],false);assert.equal(h.button(ARM).props.disabled,true);noDownload(h);
});
test('EUI02 shipped review displays literal full body/private provenance; download needs a second exact confirmation and verifies wire bytes',async t=>{
 const h=await harness(t),passage=walk(h.render()).find(n=>n.type==='pre');assert.equal(text(passage),h.selected.records[0].text);assert.match(text(h.render()),/course@example.test/);assert.match(text(h.render()),/received time: not reported/);assert.match(text(h.render()),/meaning unverified/);
 const stale=h.arm();assert.equal(h.calls.length,0);noDownload(h);assert.match(text(h.dialog()),/private message text and sender\/recipient metadata/);assert.match(text(h.dialog()),/LearnBridge-selected-gmail.json/);h.button('Cancel').props.onClick();h.render();stale();await h.flush();assert.equal(h.exports().length,0);
 const confirm=h.arm();confirm();confirm();await h.flush();assert.equal(h.exports().length,1);assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].filename,'LearnBridge-selected-gmail.json');assert.equal(await h.blobs[0].text(),JSON.stringify(h.selected));assert.match(h.values[12],/download prepared/);assert.doesNotMatch(h.values[12],/download saved|imported successfully/);
});
test('EUI03 changing account, bounded scope, policy or exact selection invalidates retained confirmation before export',async t=>{
 const changes=[h=>h.field('Connected Gmail account','select').props.onChange({target:{value:'ca_synthetic_other'}}),h=>h.field('Folder','select').props.onChange({target:{value:'SENT'}}),h=>h.field('Start UTC date').props.onChange({target:{value:'2026-09-02'}}),h=>h.field('End UTC date').props.onChange({target:{value:'2026-09-29'}}),h=>h.field('Subject phrase').props.onChange({target:{value:'Meeting'}}),h=>h.field('Academic policy','select').props.onChange({target:{value:'graded_restricted'}}),h=>h.field(' Synthetic selected email').props.onChange({target:{checked:false}})];
 for(const change of changes){const h=await harness(t);try{const stale=h.arm();change(h);stale();await h.flush();assert.equal(h.values[9],null);assert.equal(h.dialog(),undefined);assert.equal(h.exports().length,0);noDownload(h)}finally{h.dispose()}}
});
test('EUI04 unreviewing during export or asynchronous hash checks prevents late file creation',async t=>{
 for(const mode of ['network','hash']){const h=await harness(t,mode);try{h.arm()();await(mode==='network'?h.exportStarted.promise:h.hashStarted.promise);h.setReview(false);h.render();h.releaseExport.resolve();h.releaseHash.resolve();await h.flush();assert.equal(h.values[10],false);noDownload(h);if(mode==='network')assert.equal(h.exports()[0].signal.aborted,true)}finally{h.dispose()}}
});
test('EUI05 corrupt body/provenance bytes or expired/unmounted review cannot create a download',async t=>{
 const corrupt=await harness(t,'corrupted');corrupt.arm()();await corrupt.flush();noDownload(corrupt);assert.match(corrupt.values[13],/did not match this exact review/);corrupt.dispose();
 const expired=await harness(t);const stale=expired.arm();expired.advance(300001);stale();await expired.flush();assert.equal(expired.exports().length,0);noDownload(expired);expired.dispose();
 const gone=await harness(t,'network');gone.arm()();await gone.exportStarted.promise;gone.unmount();gone.releaseExport.resolve();await gone.flush();noDownload(gone);assert.equal(gone.writesAfterUnmount,0);
});
test('EUI06 actual verified hosted Blob passes shipped local file/review/import handlers with explicit owner confirmation',async t=>{
 const h=await harness(t);h.arm()();await h.flush();const blob=h.blobs[0],wire=await blob.text();assert.equal(blob.size,Buffer.byteLength(wire));
 class Node{constructor(tag,cls='',value=''){this.tagName=tag;this.className=cls;this.text=value;this.children=[];this.hidden=false;this.checked=false;this.disabled=false;this.value='';this.listeners=new Map();this.classList={toggle(){}}}append(...nodes){this.children.push(...nodes);if(this.tagName==='select'&&this.children.length===1)this.value=this.children[0].value}replaceChildren(...nodes){this.children=[];this.text='';this.append(...nodes)}setAttribute(){}addEventListener(event,callback){this.listeners.set(event,callback)}get textContent(){return this.text+this.children.map(node=>node.textContent).join('')}set textContent(value){this.text=value;this.children=[]}}
 const directory=mkdtempSync(join(tmpdir(),'learnbridge-email-ui-')),store=LocalStore.open({root:join(directory,'workspace')}),routes=createCloudOnboardingRoutes({store,clock:()=>new Date(NOW+1000).toISOString()}),root=new Node('main'),jobs=[],confirmations=[];
 const local=mountCloudOnboardingUI({root,element:(tag,cls,value)=>new Node(tag,cls,value),request:async(route,options={})=>(await routes.handle({route,method:options.method||'GET',session:{nonce:'synthetic-email-file-review'},privateBody:async()=>options.body})).data,busy(control,action){const job=Promise.resolve().then(action);jobs.push(job);return job},confirmAction:async message=>{confirmations.push(message);return true}});
 t.after(()=>{local.reset();store.close();rmSync(directory,{recursive:true,force:true})});const nodes=node=>[node,...node.children.flatMap(nodes)],file=nodes(root).find(node=>node.tagName==='input'&&node.type==='file');file.files=[{size:blob.size,text:async()=>wire}];file.listeners.get('change')();await settle();
 const button=label=>nodes(root).find(node=>node.tagName==='button'&&node.textContent===label);button('Preview exact selected cloud import').listeners.get('click')();await jobs.at(-1);assert.equal(nodes(root).find(node=>node.tagName==='pre').textContent,h.selected.records[0].text);assert.match(root.textContent,/From \(provider reported\): course@example.test/);assert.equal(store.listDocuments().length,0);
 button('Save reviewed private source copies').listeners.get('click')();await jobs.at(-1).catch(()=>{});assert.equal(store.listDocuments().length,0);assert.equal(confirmations.length,0);
 nodes(root).find(node=>node.tagName==='input'&&node.type==='checkbox').checked=true;button('Save reviewed private source copies').listeners.get('click')();await jobs.at(-1);assert.equal(store.listDocuments().length,1);assert.match(store.getDocument(store.listDocuments()[0].id).text,/Provider timestamp \(meaning unverified\):/);assert.match(confirmations[0],/account ca_synthetic_student/);assert.equal(store.listAgentGrants().length,0);assert.equal(store.listTasks().length,0);
});
