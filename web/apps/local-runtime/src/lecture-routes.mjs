import { LearnBridgeError } from '@learnbridge/core';

/** Paired local student only. No media URLs carry tokens or filesystem paths. */
export async function handleLectureRoute({route,method,session,service,privateBody,stillAuthorized,sourceOperation,idempotencyKey}) {
  if(!route.startsWith('/lectures/')&&!/^\/course-studio\/sessions\/[^/]+\/lectures$/.test(route))return null;
  const fail=code=>{throw new LearnBridgeError(code);};
  if(!session?.nonce||typeof stillAuthorized!=='function')fail('AUTH_REQUIRED');
  const authorize=()=>{stillAuthorized();return true;};authorize();
  if(route==='/lectures/capability'){if(method!=='GET')fail('INVALID_INPUT');return {status:200,data:await service.capability()};}
  const selected=/^\/course-studio\/sessions\/([a-f0-9-]{36})\/lectures$/.exec(route);
  if(selected){if(method==='GET')return {status:200,data:{items:service.list(selected[1]),capability:await service.capability()}};if(method!=='POST')fail('INVALID_INPUT');const fields=['expected_revision','studio_hash','pages','title','quiz_every','confirmed'],body=await privateBody(fields,fields,4096);authorize();return {status:201,data:{item:await service.create(selected[1],body,{idempotencyKey})}};}
  let match=/^\/lectures\/([a-f0-9-]{36})(?:\/(preview-run|run|review-preview|accept|audio|progress|answer|clarification-preview|clarifications|export-video|video|cancel|remove-media))?$/.exec(route);
  if(match){const id=match[1],action=match[2];if(!action){if(method!=='GET')fail('INVALID_INPUT');return {status:200,data:await service.get(id)};}
    if(action==='review-preview'){if(method!=='GET')fail('INVALID_INPUT');return {status:200,data:service.reviewPreview(id)};}
    if(action==='video'){if(method!=='GET')fail('INVALID_INPUT');const result=await service.video(id,{authorize});authorize();return {status:200,...result};}
    if(method!=='POST')fail('INVALID_INPUT');
    const fields={ 'preview-run':[],run:['grant_id','prompt_sha256','confirmed'],accept:['output_sha256','pack_hash','confirmed'],audio:['voice','rate','confirmed'],progress:['chapter_index','position_seconds','state','completed_chapter_ids'],answer:['quiz_id','response'],'clarification-preview':['chapter_id','question'],clarifications:['chapter_id','question','grant_id','prompt_sha256','confirmed'],'export-video':['confirmed'],cancel:['confirmed'],'remove-media':['confirmed'] }[action];
    const keys=['expected_revision','lecture_hash',...fields],body=await privateBody(keys,keys,['answer','clarification-preview','clarifications'].includes(action)?16000:4096);authorize();
    const name={'preview-run':'previewRun',run:'run',accept:'accept',audio:'prepareAudio',progress:'progress',answer:'answer','clarification-preview':'clarificationPreview',clarifications:'clarify','export-video':'exportVideo',cancel:'cancel','remove-media':'removeMedia'}[action];
    const result=await service[name](id,body,{idempotencyKey,authorize});authorize();
    return {status:['run','audio','clarifications','export-video'].includes(action)?202:200,data:['preview-run','clarification-preview','answer'].includes(action)?result:{item:result}};
  }
  match=/^\/lectures\/([a-f0-9-]{36})\/chapters\/(p[1-9]\d{0,2})\/(asset|audio)$/.exec(route);
  if(match){if(method!=='GET')fail('INVALID_INPUT');if(match[3]==='audio'){const result=await service.audio(match[1],match[2],{authorize});authorize();return {status:200,...result};}const result=await (sourceOperation?sourceOperation(signal=>service.asset(match[1],match[2],{signal})):service.asset(match[1],match[2]));authorize();return {status:200,data:{asset:result}};}
  return null;
}
