import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const {NextRequest}=require('next/server');
const {unstable_doesMiddlewareMatch}=require('next/experimental/testing/server');
const proxySource=readFileSync(new URL('../apps/web/src/proxy.ts',import.meta.url),'utf8');

// Load the shipped proxy, replacing only the external auth client. Next handles
// the real matcher, request headers, forwarded request cookies and response cookies.
function loadProxy(createServerClient){
 const code=ts.transpileModule(proxySource,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
 }}).outputText;
 const module={exports:{}};
 new Function('require','module','exports',code)(id=>{
  if(id==='@supabase/ssr')return {createServerClient};
  return require(id);
 },module,module.exports);
 return module.exports;
}

async function withConfiguration(operation,configured=true){
 const names=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','APP_URL'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try{
  if(configured){
   process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth-fixture.example.invalid';
   process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='public-fixture-key';
  }else{
   delete process.env.NEXT_PUBLIC_SUPABASE_URL;
   delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  }
  process.env.APP_URL='https://learnbridge.example.invalid';
  return await operation();
 }finally{
  for(const name of names){
   if(previous[name]===undefined)delete process.env[name];
   else process.env[name]=previous[name];
  }
 }
}

test('connected private pages run the actual Next auth matcher while public setup stays accessible',()=>{
 const {config}=loadProxy(()=>{throw new Error('Matcher verification must not call auth');});
 for(const path of ['/', '/tutor','/tutor/session','/workspace','/workspace/notes',
  '/connections','/onboarding','/onboarding/cloud','/onboarding/cloud/review','/remote','/remote/replies']){
  assert.equal(unstable_doesMiddlewareMatch({config,url:`https://learnbridge.example.invalid${path}`}),true,path);
 }
 for(const path of ['/setup','/setup?from=phone','/login','/api/healthz','/api/cloud-onboarding/accounts']){
  assert.equal(unstable_doesMiddlewareMatch({config,url:`https://learnbridge.example.invalid${path}`}),false,path);
 }
});

test('refreshed auth cookies reach the server-rendered request and browser with private response caching',async()=>{
 await withConfiguration(async()=>{
  let authCalls=0;
  const {proxy}=loadProxy((url,key,options)=>{
   assert.equal(url,'https://auth-fixture.example.invalid');
   assert.equal(key,'public-fixture-key');
   assert.deepEqual(options.cookieOptions,{httpOnly:true,sameSite:'lax',secure:true});
   assert.deepEqual(options.cookies.getAll(),[{name:'sb-fixture-auth-token',value:'expired-fixture'}]);
   return {auth:{async getUser(){
    authCalls++;
    options.cookies.setAll([
     {name:'sb-fixture-auth-token',value:'refreshed-fixture',options:{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:3600}},
     {name:'sb-fixture-auth-token.1',value:'second-chunk',options:{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:3600}},
    ]);
    return {data:{user:{id:'synthetic-student'}},error:null};
   }}};
  });
  const request=new NextRequest('https://learnbridge.example.invalid/onboarding/cloud',{
   headers:{cookie:'sb-fixture-auth-token=expired-fixture'},
  });
  const response=await proxy(request);
  assert.equal(authCalls,1);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-middleware-next'),'1');
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(request.cookies.get('sb-fixture-auth-token')?.value,'refreshed-fixture');
  assert.equal(request.cookies.get('sb-fixture-auth-token.1')?.value,'second-chunk');
  assert.match(response.headers.get('x-middleware-request-cookie'),/sb-fixture-auth-token=refreshed-fixture/);
  assert.match(response.headers.get('x-middleware-request-cookie'),/sb-fixture-auth-token\.1=second-chunk/);
  for(const name of ['sb-fixture-auth-token','sb-fixture-auth-token.1']){
   const cookie=response.cookies.get(name);
   assert.equal(cookie.httpOnly,true);
   assert.equal(cookie.secure,true);
   assert.equal(cookie.sameSite,'lax');
   assert.equal(cookie.path,'/');
   assert.equal(cookie.maxAge,3600);
  }
  assert.doesNotMatch(await response.text(),/synthetic-student|refreshed-fixture|second-chunk/);
 });
});

test('invalid or absent auth redirects carry cookie clearing and are never publicly cached',async()=>{
 await withConfiguration(async()=>{
  for(const authResult of [
   {data:{user:null},error:null},
   {data:{user:{id:'synthetic-student'}},error:{message:'invalid-fixture-token'}},
  ]){
   const {proxy}=loadProxy((_url,_key,options)=>({auth:{async getUser(){
    options.cookies.setAll([{name:'sb-fixture-auth-token',value:'',options:{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:0}}]);
    return authResult;
   }}}));
   const request=new NextRequest('https://learnbridge.example.invalid/remote?private=fixture',{
    headers:{cookie:'sb-fixture-auth-token=expired-fixture'},
   });
   const response=await proxy(request);
   assert.equal(response.status,307);
   assert.equal(response.headers.get('location'),'https://learnbridge.example.invalid/login');
   assert.equal(response.headers.get('Cache-Control'),'private, no-store');
   assert.equal(response.headers.get('x-middleware-next'),null);
   assert.equal(response.headers.get('x-middleware-request-cookie'),null);
   const cookie=response.cookies.get('sb-fixture-auth-token');
   assert.equal(cookie.value,'');
   assert.equal(cookie.maxAge,0);
   assert.equal(cookie.httpOnly,true);
   assert.equal(cookie.secure,true);
   assert.doesNotMatch(await response.text(),/synthetic-student|invalid-fixture-token|private=fixture/);
  }
 });
});

test('missing public auth configuration fails closed without invoking an auth client or cacheable redirect',async()=>{
 await withConfiguration(async()=>{
  let calls=0;
  const {proxy}=loadProxy(()=>{calls++;throw new Error('No auth call should occur without configuration');});
  const response=await proxy(new NextRequest('https://learnbridge.example.invalid/onboarding/cloud'));
  assert.equal(calls,0);
  assert.equal(response.status,307);
  assert.equal(response.headers.get('location'),'https://learnbridge.example.invalid/login');
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(response.headers.get('x-middleware-next'),null);
  assert.equal(response.cookies.getAll().length,0);
 },false);
});
