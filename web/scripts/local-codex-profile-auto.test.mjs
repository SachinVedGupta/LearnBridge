import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { createCodexProfile } from '../apps/local-runtime/src/codex-profile.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const auth={sessionId:'synthetic-auto-browser',authorize:()=>true};
// Model/account replies are synthetic. Selected-context reads use real private
// SQLite and grant accounting; CTP08 separately exercises actual stdio MCP/IPC.
function fixture(t,{supported=false,capability,phase,errorCode='UNSUPPORTED',mutate,executionMode}={}) {
  const parent=realpathSync(mkdtempSync(join(tmpdir(),'learnbridge-codex-auto-'))),store=LocalStore.open({root:join(parent,'workspace')});
  const note=store.createDocument({title:'Selected synthetic note',text:'A base case stops recursion.'});
  store.createDocument({title:'Unselected synthetic note',text:'PRIVATE_UNSELECTED_AUTO_CANARY'});
  const grant=store.createAgentGrant({destination:'codex',document_ids:[note.document.id],max_bytes:64000,expires_in_minutes:5});
  const calls=[],events=[];let releases=0;
  const trip=name=>{if(name===phase)throw new LearnBridgeError(errorCode);};
  const profile=createCodexProfile({store,profileRoot:join(parent,'owned-profile'),...(executionMode?{executionMode}:{}),
    leaseFactory:(id,allowed,policy)=>{assert.equal(id,grant.id);assert.equal(allowed(),true);assert.equal(policy,'read_only');return{id:randomUUID(),permitTool:()=>()=>{},release:()=>{releases++;}};},
    adapterFactory:input=>{
      const record={input,closed:false};calls.push(record);const selected=input.grantId===grant.id;
      const log=name=>events.push({name,modelTools:input.modelTools});
      return {
        async initialize(){log('initialize');if(selected)trip('initialize');return{state:'available'};},
        async directFunctionCapability(){log('capability');trip('capability');return capability??{supported,model:supported?'gpt-5.5':null};},
        async startThread(){log('thread');trip('thread');assert.equal(input.authorize(),true);},
        async callLearnBridgeTool(tool,args){log(tool);trip('context');assert.equal(input.modelTools,false);assert.equal(input.authorize(),true);
          const value=tool==='learnbridge_context'?store.agentContext({destination:'codex',...args}):{healthy:true};
          const receipt={tool,status:'completed',failed:false,result_hash:sha(JSON.stringify(value)),origin:'runtime'};
          mutate?.('receipt',receipt);return{value,receipt};},
        async startTurn(value){log('turn');trip('turn');assert.deepEqual(value.outputSchema.required,['answer']);
          if(!input.modelTools){const context=JSON.parse(value.context);assert.deepEqual(context.documents.map(item=>item.id),[note.document.id]);assert.equal(JSON.stringify(context).includes('PRIVATE_UNSELECTED_AUTO_CANARY'),false);}
          const result={status:'completed',turn_id:'synthetic-auto-turn',text:JSON.stringify({answer:'Use the selected base case to stop recursion.'}),
            tool_receipts:input.modelTools?['learnbridge_status','learnbridge_context'].map(tool=>({tool,status:'completed',failed:false,result_hash:sha(tool),origin:'model'})):[],error:null};
          mutate?.('result',result);return{completion:Promise.resolve(result)};},
        async close(){log('close');record.closed=true;},
      };
    }});
  t.after(async()=>{await profile.stop();store.close();rmSync(parent,{recursive:true,force:true});});
  const execute=async()=>{await profile.connect(auth);return profile.execute({grantId:grant.id,prompt:'Explain my selected note.',authorize:()=>true,toolPolicy:'read_only'});};
  return{profile,store,grant,note,calls,events,execute,releases:()=>releases};
}

test('CPA01 default auto mode chooses audited eager functions and reports only the verified completed delivery',async t=>{
  const f=fixture(t,{supported:true});assert.equal(f.profile.status().execution_selection,'auto');assert.equal(f.profile.status().tool_execution,'unverified');
  const result=await f.execute();assert.equal(result.context_delivery,'model_requested');assert.equal(result.state,'completed');
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].input.modelTools,false);assert.equal(f.calls[1].input.modelTools,true);
  assert.deepEqual(f.events.filter(item=>item.name==='turn').map(item=>item.modelTools),[true]);
  assert.equal(f.events.some(item=>item.name==='learnbridge_context'),false);
  assert.equal(f.profile.status().tool_execution,'model_requested');assert.equal(f.profile.status().model_entitlement_verified,true);
  assert.equal(f.releases(),1);assert(f.calls.every(item=>item.closed&&!existsSync(item.input.projectRoot)));
  await f.profile.connect(auth);assert.equal(f.profile.status().context_delivery,null);assert.equal(f.profile.status().model_entitlement_verified,false);
  await f.profile.clear();assert.equal(f.profile.status().context_delivery,null);assert.equal(f.profile.status().tool_execution,'unverified');
});

test('CPA02 validated capability absence closes the probe before a fresh bounded runtime-prepared turn',async t=>{
  const f=fixture(t);const before=f.store.assertAgentGrant({destination:'codex',grant_id:f.grant.id}),result=await f.execute();
  assert.equal(result.context_delivery,'runtime_prepared');assert.deepEqual(result.tool_receipts.map(item=>item.origin),['runtime','runtime']);
  assert.deepEqual(f.events.map(item=>[item.name,item.modelTools]),[['initialize',false],['close',false],['initialize',true],['capability',true],['close',true],['initialize',false],['thread',false],['learnbridge_status',false],['learnbridge_context',false],['turn',false],['close',false]]);
  const after=f.store.assertAgentGrant({destination:'codex',grant_id:f.grant.id});
  assert.equal(after.consent_fingerprint,before.consent_fingerprint);
  assert.equal(after.revision,before.revision+1);assert.equal(f.profile.status().tool_execution,'runtime_prepared');
  assert.equal(f.calls[2].input.toolPolicy,'read_only');assert(f.calls.every(item=>item.closed&&!existsSync(item.input.projectRoot)));
  assert.equal(f.releases(),1);assert.equal(f.store.listTasks().length,0);assert.equal(f.store.listTaskProposals().length,0);
});

test('CPA03 authority, protocol, catalog RPC and thread failures never become a fallback',async t=>{
  for(const phase of ['initialize','capability','thread'])for(const errorCode of ['UNSUPPORTED','AUTH_REQUIRED','SCOPE_DENIED','VERSION_MISMATCH','OFFLINE']){
    const f=fixture(t,{phase,errorCode,supported:true});await assert.rejects(f.execute(),{code:errorCode});
    assert.equal(f.calls.length,2,phase+':'+errorCode);assert.equal(f.events.some(item=>['turn','learnbridge_context'].includes(item.name)),false);
    assert.equal(f.profile.status().model_entitlement_verified,false);assert.equal(f.profile.status().context_delivery,null);
    assert.equal(f.releases(),1);assert(f.calls.every(item=>item.closed));
  }
});

test('CPA04 failure during approved context or after model dispatch never replays the turn',async t=>{
  const context=fixture(t,{phase:'context'});await assert.rejects(context.execute(),{code:'UNSUPPORTED'});
  assert.equal(context.calls.length,3);assert.equal(context.events.some(item=>item.name==='turn'),false);
  const eager=fixture(t,{supported:true,phase:'turn'});await assert.rejects(eager.execute(),{code:'UNSUPPORTED'});
  assert.equal(eager.calls.length,2);assert.equal(eager.events.filter(item=>item.name==='turn').length,1);
  const prepared=fixture(t,{phase:'turn'});await assert.rejects(prepared.execute(),{code:'UNSUPPORTED'});
  assert.equal(prepared.calls.length,3);assert.equal(prepared.events.filter(item=>item.name==='turn').length,1);
  const unknown=fixture(t,{supported:true,mutate:(phase,result)=>{if(phase==='result')Object.assign(result,{status:'unknown_outcome',error:{code:'UNKNOWN_OUTCOME'}});}});
  const output=await unknown.execute();assert.equal(output.state,'unknown_outcome');assert.equal(output.complete,false);assert.equal(unknown.calls.length,2);
  assert.equal(unknown.profile.status().tool_execution,'unverified');
});

test('CPA05 malformed capabilities, missing proof and wrong receipt origins cannot claim successful context delivery',async t=>{
  for(const capability of [{supported:false,model:'gpt-5.5'},{supported:true,model:'gpt-5.6-sol'},{supported:false,model:null,extra:true}]){
    const f=fixture(t,{capability});await assert.rejects(f.execute(),{code:'VERSION_MISMATCH'});assert.equal(f.calls.length,2);assert.equal(f.events.some(item=>item.name==='turn'),false);
  }
  for(const origin of [undefined,'model']){
    const f=fixture(t,{mutate:(phase,receipt)=>{if(phase==='receipt')receipt.origin=origin;}});await assert.rejects(f.execute(),{code:'VERSION_MISMATCH'});
    assert.equal(f.events.some(item=>item.name==='turn'),false);assert.equal(f.profile.status().context_delivery,null);
  }
  const missing=fixture(t,{supported:true,mutate:(phase,result)=>{if(phase==='result')result.tool_receipts=[];}});
  await assert.rejects(missing.execute(),{code:'VERSION_MISMATCH'});assert.equal(missing.calls.length,2);assert.equal(missing.profile.status().model_entitlement_verified,false);
  const hidden=fixture(t,{mutate:(phase,result)=>{if(phase==='result')result.tool_receipts=[{tool:'learnbridge_context'}];}});
  await assert.rejects(hidden.execute(),{code:'SCOPE_DENIED'});assert.equal(hidden.events.filter(item=>item.name==='turn').length,1);
});

test('CPA06 forced model mode remains strict and forced structured mode performs no catalog probe',async t=>{
  const model=fixture(t,{executionMode:'model',phase:'thread'});await assert.rejects(model.execute(),{code:'UNSUPPORTED'});
  assert.equal(model.calls.length,2);assert.equal(model.events.some(item=>item.name==='capability'),false);
  const structured=fixture(t,{executionMode:'structured'});assert.equal((await structured.execute()).context_delivery,'runtime_prepared');
  assert.equal(structured.calls.length,2);assert.equal(structured.events.some(item=>item.name==='capability'),false);
});
