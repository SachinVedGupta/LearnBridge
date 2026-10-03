import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {LocalStore,STORAGE_SCHEMA_VERSION} from '../packages/local-storage/src/index.mjs';
import {validatePdfProvenance} from '../packages/local-storage/src/pdf-provenance.mjs';
import {createInstallation,createTask} from '../packages/core/src/index.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const source=readFileSync(new URL('../packages/local-storage/src/index.mjs',import.meta.url),'utf8');
const migration=n=>new RegExp('const MIGRATION'+(n===1?'':'_V'+n)+' = `([\\s\\S]*?)`;','u').exec(source)[1];
const moduleUrl=new URL('../packages/local-storage/src/index.mjs',import.meta.url).href;
function fixture(t){const parent=mkdtempSync(join(tmpdir(),'learnbridge-pdf-storage-')),root=join(parent,'workspace'),store=LocalStore.open({root});t.after(()=>{store.close();rmSync(parent,{recursive:true,force:true});});return {parent,root,store};}
function data(){const page='A base case terminates recursion. café 🧠',prefix='[PDF page 1]\n',text=prefix+page;return {text,pdf:{schema_version:1,format:'pdf_text',parser_version:'macos_pdfkit.v1',source_sha256:sha(Buffer.alloc(400)),source_bytes:400,page_count:1,pages:[{physical_page:1,printed_label:'i',text:page,sha256:sha(page),byte_range:{start:Buffer.byteLength(prefix),end:Buffer.byteLength(text)}}],extraction_status:'available',coverage:{state:'complete',reasons:[]}}};}
function selected(store){const descriptor={schema_version:1,kind:'local-directory',root:'/synthetic-selected-root',label:'Synthetic PDF source',identity:{dev:'10',ino:'20'},version:sha('synthetic descriptor')},source=store.createSource({label:descriptor.label,descriptor}),entryId=randomUUID(),version=sha('synthetic binary file metadata');const inventory={schema_version:1,id:randomUUID(),source_version:descriptor.version,version:sha('synthetic inventory'),entries:[{id:entryId,relativePath:'lecture.pdf',kind:'pdf',title:'lecture.pdf',snapshot:{dev:'10',ino:'21',size:400,mtimeNs:'100',ctimeNs:'100',nlink:1,version},directories:[{relativePath:'',identity:{dev:'10',ino:'20',mtimeNs:'90',ctimeNs:'90'}}]}],counts:{entriesVisited:1,directoriesVisited:1,eligibleFiles:1,excludedEntries:0,totalBytes:400},exclusions:{secret:0,symlink:0,special:0,unsupportedType:0,hardlink:0,depth:0,permission:0,changed:0},budget:{maxEntries:100,maxFiles:100,maxDepth:3},coverage:{state:'complete',reasons:[]},retrieved_at:new Date().toISOString()};const saved=store.saveSourceInventory(source.id,inventory),value=data();return {source,input:{source_id:source.id,inventory_id:saved.id,entry_id:entryId,title:'lecture.pdf',version,text:value.text,sha256:sha(value.text),pdf:value.pdf}};}

test('PDF provenance pins exact UTF-8 page ranges, original hash and coverage without unexplained text',()=>{const {pdf,text}=data();assert.deepEqual(validatePdfProvenance(pdf,text,400),pdf);for(const changed of [{...pdf,source_bytes:401},{...pdf,extraction_status:'text_unavailable'},{...pdf,coverage:{state:'complete',reasons:['missing']}},{...pdf,page_count:2},{...pdf,pages:[{...pdf.pages[0],byte_range:{start:0,end:1}}]},{...pdf,pages:[{...pdf.pages[0],sha256:'0'.repeat(64)}]}])assert.throws(()=>validatePdfProvenance(changed,text,400));assert.throws(()=>validatePdfProvenance(pdf,text+'UNREFERENCED_TEXT',400),{code:'VERSION_MISMATCH'});let getter=0;const hostile={...pdf};Object.defineProperty(hostile,'pages',{enumerable:true,get(){getter++;return pdf.pages;}});assert.throws(()=>validatePdfProvenance(hostile,text,400));assert.equal(getter,0);});

test('exact PDF provenance persists with selected context and rejects altered retries atomically',t=>{const {store,root}=fixture(t),{input}=selected(store),imported=store.importSourceEntry(input);assert.deepEqual(imported.pdf,input.pdf);assert.equal(store.importSourceEntry(input).id,imported.id);assert.throws(()=>store.importSourceEntry({...input,pdf:{...input.pdf,source_sha256:'1'.repeat(64)}}),{code:'REVISION_CONFLICT'});assert.equal(store.listSourceEntries().length,1);const grant=store.createAgentGrant({destination:'codex',task_ids:[],document_ids:[],source_entry_ids:[imported.id],max_bytes:48000,expires_in_minutes:10}),context=store.agentContext({destination:'codex',grant_id:grant.id});assert.deepEqual(context.source_entries[0].pdf,input.pdf);assert.equal(context.source_entries[0].trust,'untrusted_source_content');assert.equal(JSON.stringify(context).includes('/synthetic-selected-root'),false);store.close();const reopened=LocalStore.open({root});try{assert.deepEqual(reopened.getSourceEntry(imported.id),imported);assert.equal(reopened.integrity().source_provenance_count,1);}finally{reopened.close();}});

test('page citations point to canonical bodies even when identical text occurs in headers or another page',()=>{
  const {pdf}=data(), bodies=['PDF','λ PDF 🧠','PDF']; let cursor=0;
  const pages=bodies.map((text,index)=>{cursor+=(index?2:0)+Buffer.byteLength(`[PDF page ${index+1}]\n`);const start=cursor;cursor+=Buffer.byteLength(text);return{physical_page:index+1,printed_label:null,text,sha256:sha(text),byte_range:{start,end:cursor}};});
  const text=pages.map(page=>`[PDF page ${page.physical_page}]\n${page.text}`).join('\n\n'), metadata={...pdf,page_count:3,pages};
  assert.deepEqual(validatePdfProvenance(metadata,text,400),metadata);
  assert.throws(()=>validatePdfProvenance({...metadata,pages:[{...pages[0],byte_range:{start:1,end:4}},...pages.slice(1)]},text,400),{code:'VERSION_MISMATCH'});
  assert.throws(()=>validatePdfProvenance({...metadata,pages:[...pages.slice(0,2),{...pages[2],byte_range:pages[0].byte_range}]},text,400));
});

test('unavailable extraction and missing provenance create no usable imported source',t=>{const {store}=fixture(t),{input}=selected(store);for(const payload of [{...input,pdf:undefined},{...input,text:'',sha256:sha(''),pdf:{...input.pdf,extraction_status:'encrypted',pages:[],coverage:{state:'unavailable',reasons:['encrypted']}}}])assert.throws(()=>store.importSourceEntry(payload));assert.equal(store.listSourceEntries().length,0);assert.equal(store.integrity().source_provenance_count,0);});

function assertPdfRows(root,expected){const db=new Database(join(root,'learnbridge.sqlite'),{readonly:true,fileMustExist:true});try{
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_entries').get().n,expected);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_provenance').get().n,expected);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_entries e LEFT JOIN source_provenance p ON p.entry_id=e.id WHERE p.entry_id IS NULL').get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
}finally{db.close();}}
function retryPdfOnce(root,input){const reopened=LocalStore.open({root});try{
  assert.equal(reopened.listSourceEntries().length,0);assert.equal(reopened.integrity().source_provenance_count,0);
  const imported=reopened.importSourceEntry(input),retry=reopened.importSourceEntry(input);
  assert.equal(retry.id,imported.id);assert.deepEqual(reopened.getSourceEntry(imported.id).pdf,input.pdf);
  assert.equal(reopened.listSourceEntries().length,1);assert.equal(reopened.integrity().source_provenance_count,1);
}finally{reopened.close();}assertPdfRows(root,1);}

test('actual SQL abort between source entry and provenance rolls back both tables; reopen and exact retry import once',t=>{
  const {store,root}=fixture(t),{input}=selected(store),injector=new Database(join(root,'learnbridge.sqlite'));
  const original=Database.prototype.prepare;let nativeError;
  try{
    // The trigger proves the first row exists inside this transaction before
    // issuing a real SQLite error at the second table's insertion boundary.
    injector.exec(`CREATE TRIGGER synthetic_pdf_provenance_abort BEFORE INSERT ON source_provenance BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM source_entries WHERE id=NEW.entry_id)
      THEN RAISE(ABORT,'synthetic PDF provenance SQL abort') ELSE RAISE(ABORT,'missed PDF two-table boundary') END;
    END;`);
    // Forward the real INSERT unchanged and observe its native failure before
    // the public storage boundary normalizes provider errors.
    Database.prototype.prepare=function(sql){const statement=original.call(this,sql);
      if(sql==='INSERT INTO source_provenance VALUES (?,?,?,?)')return{run(...args){try{return statement.run(...args);}catch(error){nativeError=error;throw error;}}};
      return statement;
    };
    assert.throws(()=>store.importSourceEntry(input),{code:'PROVIDER_FAILURE'});
    assert.equal(nativeError?.code,'SQLITE_CONSTRAINT_TRIGGER');assert.equal(nativeError?.message,'synthetic PDF provenance SQL abort');
  }finally{Database.prototype.prepare=original;injector.exec('DROP TRIGGER IF EXISTS synthetic_pdf_provenance_abort');injector.close();}
  assert.equal(store.listSourceEntries().length,0);assert.equal(store.integrity().source_provenance_count,0);
  store.close();assertPdfRows(root,0);retryPdfOnce(root,input);
});

test('actual child SIGKILL after source entry insert leaves no orphan on reopen; exact retry imports one PDF',t=>{
  const {store,root}=fixture(t),{input}=selected(store);store.close();
  const code=`import{LocalStore}from${JSON.stringify(moduleUrl)};import Database from'better-sqlite3';import{writeSync}from'node:fs';
    const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){const statement=original.call(this,sql);
      if(sql==='INSERT INTO source_provenance VALUES (?,?,?,?)'){const db=this;return{run(...args){
        if(original.call(db,'SELECT count(*) AS n FROM source_entries WHERE id=?').get(args[0]).n!==1)throw new Error('missed PDF two-table boundary');
        writeSync(1,'PDF_TWO_TABLE_BOUNDARY\\n');process.kill(process.pid,'SIGKILL');
      }};}return statement;};const store=LocalStore.open({root:${JSON.stringify(root)}});store.importSourceEntry(${JSON.stringify(input)});`;
  const env=Object.fromEntries(['PATH','TMPDIR','TEMP','TMP'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env,cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL');assert.equal(child.stdout,'PDF_TWO_TABLE_BOUNDARY\n');assert.equal(child.stderr,'');
  assertPdfRows(root,0);retryPdfOnce(root,input);
});

test('fresh-root backup preserves immutable provenance; revoked source cannot disclose pages',async t=>{const {store,parent}=fixture(t),{source,input}=selected(store),saved=store.importSourceEntry(input),backup=join(parent,'backup');await store.backup(backup);const restored=join(parent,'restored');await LocalStore.restore({backupRoot:backup,root:restored});const copy=LocalStore.open({root:restored});try{assert.deepEqual(copy.getSourceEntry(saved.id),saved);assert.equal(copy.integrity().schema_version,4);copy.revokeSource(source.id,source.revision);assert.throws(()=>copy.getSourceEntry(saved.id),{code:'CONSENT_REQUIRED'});assert.deepEqual(copy.listSourceEntries(),[]);}finally{copy.close();}const db=new Database(join(backup,'learnbridge.sqlite'));try{assert.throws(()=>db.prepare('UPDATE source_provenance SET json=?').run('{}'),/immutable source provenance/);assert.throws(()=>db.prepare('DELETE FROM source_provenance').run(),/immutable source provenance/);}finally{db.close();}});

function legacy(parent){const root=join(parent,'legacy-v3');mkdirSync(root,{mode:0o700});writeFileSync(join(root,'.learnbridge-local-root'),'learnbridge-local-data-v1\n',{mode:0o600});const installation=createInstallation({student_id:randomUUID(),platform:process.platform,data_root_ref:'private-local-root',edition:'local',timezone:'UTC',setup_version:'0.1.0'}),task=createTask({student_id:installation.student_id,title:'Legacy v3 synthetic task'}),db=new Database(join(root,'learnbridge.sqlite'));try{for(let n=1;n<=3;n++){db.exec(migration(n));db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(n,sha(migration(n)));}db.prepare('INSERT INTO installation VALUES (1,?)').run(JSON.stringify(installation));db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run('task',task.id,task.student_id,task.revision,null,JSON.stringify(task));}finally{db.close();}return {root,installation,task};}

test('additive v3→v4 upgrade preserves identity, task and every historical SQL checksum',t=>{const parent=mkdtempSync(join(tmpdir(),'learnbridge-v4-upgrade-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));const {root,installation,task}=legacy(parent),store=LocalStore.open({root});try{assert.deepEqual(store.identity,installation);assert.deepEqual(store.getTask(task.id),task);assert.equal(store.integrity().schema_version,STORAGE_SCHEMA_VERSION);}finally{store.close();}const db=new Database(join(root,'learnbridge.sqlite'));try{const ledger=db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();assert.equal(ledger.length,4);for(let n=1;n<=4;n++)assert.equal(ledger[n-1].checksum,sha(migration(n)));}finally{db.close();}});

test('SIGKILL during v4 migration rolls back schema and preserves the previous valid workspace',t=>{const parent=mkdtempSync(join(tmpdir(),'learnbridge-v4-kill-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));const {root,installation,task}=legacy(parent),code=`import{LocalStore}from${JSON.stringify(moduleUrl)};import Database from'better-sqlite3';const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){if(sql==='INSERT INTO schema_migrations VALUES (4,?)')return{run(){process.kill(process.pid,'SIGKILL')}};return original.call(this,sql)};LocalStore.open({root:${JSON.stringify(root)}});`;const env=Object.fromEntries(['PATH','TMPDIR','TEMP','TMP'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),child=spawnSync(process.execPath,['--input-type=module','-e',code],{env,cwd:new URL('..',import.meta.url),timeout:10000});assert.equal(child.signal,'SIGKILL');const db=new Database(join(root,'learnbridge.sqlite'));try{assert.equal(db.pragma('user_version',{simple:true}),3);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='source_provenance'").get().n,0);}finally{db.close();}const reopened=LocalStore.open({root});try{assert.deepEqual(reopened.identity,installation);assert.deepEqual(reopened.getTask(task.id),task);assert.equal(reopened.integrity().schema_version,4);}finally{reopened.close();}});
