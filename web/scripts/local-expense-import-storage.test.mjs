import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-expense-batch-'));
  let store = LocalStore.open({ root: join(root, 'workspace') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const preview = store.createWorkspaceRecord({kind:'administration_item',title:'Synthetic CSV preview',data:{format:'expense_import_preview_v1',category:'expense_import_preview',state:'awaiting_review'}});
  return { root, preview, get store(){ return store; }, reopen(){store.close();store=LocalStore.open({root:join(root,'workspace')});return store;} };
}
const expense = () => ({id:randomUUID(),kind:'expense',title:'Synthetic confirmed expense',data:{category:'expense',expense:{source_id:randomUUID(),date:'2026-10-04',merchant:'Synthetic store',category:'food',amount_cents:125,currency:'CAD',confirmed:true}}});
const update = p => ({id:p.id,expected_revision:p.revision,data:{...p.data,state:'committed',receipt:'synthetic exact reviewed batch'}});
const denied = (fn,code) => assert.throws(fn, e => e.code===code);
test('EXST01: fifty expenses and one review receipt commit together and survive reopen', t => {
  const f=fixture(t),creates=Array.from({length:50},expense);
  const result=f.store.commitExpenseImportBatch({creates,preview_update:update(f.preview)});
  assert.equal(result.creates.length,50);assert.equal(result.updates.length,1);assert.equal(result.updates[0].revision,2);
  f.reopen();assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,50);assert.equal(f.store.getWorkspaceRecord(f.preview.id).data.state,'committed');
  denied(()=>f.store.commitExpenseImportBatch({creates,preview_update:update(f.preview)}),'REVISION_CONFLICT');
  assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,50);
});
test('EXST02: narrow import rejects unrelated kinds/categories/current records and the general batch stays capped', t=>{
  const f=fixture(t),candidate=expense();
  denied(()=>f.store.commitWorkspaceBatch({creates:Array.from({length:5},expense),updates:[]}),'INVALID_INPUT');
  denied(()=>f.store.commitExpenseImportBatch({creates:Array.from({length:51},expense),preview_update:update(f.preview)}),'INVALID_INPUT');
  for(const bad of [{...candidate,kind:'profile_fact'},{...candidate,data:{category:'other'}}]) denied(()=>f.store.commitExpenseImportBatch({creates:[bad],preview_update:update(f.preview)}),'SCOPE_DENIED');
  const other=f.store.createWorkspaceRecord({kind:'administration_item',title:'Unrelated',data:{category:'other'}});
  denied(()=>f.store.commitExpenseImportBatch({creates:[candidate],preview_update:{id:other.id,expected_revision:1,data:{category:'expense_import_preview',format:'expense_import_preview_v1'}}}),'SCOPE_DENIED');
  denied(()=>f.store.commitExpenseImportBatch({creates:[candidate],preview_update:{...update(f.preview),data:{category:'other'}}}),'SCOPE_DENIED');
  assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,0);assert.equal(f.store.getWorkspaceRecord(f.preview.id).revision,1);
});
test('EXST03: duplicate IDs, stale preview and hostile accessors never publish a partial batch',t=>{
  const f=fixture(t),candidate=expense();
  denied(()=>f.store.commitExpenseImportBatch({creates:[candidate,candidate],preview_update:update(f.preview)}),'INVALID_INPUT');
  denied(()=>f.store.commitExpenseImportBatch({creates:[candidate],preview_update:{...update(f.preview),expected_revision:2}}),'REVISION_CONFLICT');
  let calls=0;const hostile=expense();Object.defineProperty(hostile,'data',{enumerable:true,get(){calls++;return {category:'expense'};}});
  denied(()=>f.store.commitExpenseImportBatch({creates:[hostile],preview_update:update(f.preview)}),'INVALID_INPUT');assert.equal(calls,0);
  assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,0);assert.equal(f.store.getWorkspaceRecord(f.preview.id).revision,1);
});
test('EXST04: real SQL abort after the first expense rolls back expenses, revisions and receipt',t=>{
  const f=fixture(t),a=expense(),b=expense();const db=new DatabaseSync(join(f.root,'workspace','learnbridge.sqlite'));
  try {
    db.exec(`CREATE TRIGGER synthetic_expense_abort BEFORE INSERT ON workspace_records WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END;`);
    assert.throws(()=>f.store.commitExpenseImportBatch({creates:[a,b],preview_update:update(f.preview)}));
    assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,0);assert.equal(f.store.getWorkspaceRecord(f.preview.id).revision,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_revisions WHERE record_id IN (?,?)').get(a.id,b.id).n,0);
    db.exec('DROP TRIGGER synthetic_expense_abort');
    assert.equal(f.store.commitExpenseImportBatch({creates:[a,b],preview_update:update(f.preview)}).creates.length,2);
  }finally{db.close();}
});
test('EXST05: an all-deduplicated import can publish only its exact review receipt',t=>{
  const f=fixture(t);const result=f.store.commitExpenseImportBatch({creates:[],preview_update:update(f.preview)});
  assert.equal(result.creates.length,0);assert.equal(result.updates[0].revision,2);assert.equal(f.store.listWorkspaceRecords({kind:'expense'}).length,0);
});
