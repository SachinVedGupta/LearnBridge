import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { workflowHash } from './workflows.mjs';
import { lifeStamp, lifeDate, lifeTimezone } from './life.mjs';

export const CALENDAR_IMPORT_LIMITS = Object.freeze({ file_bytes: 48000, events: 100, components: 200, lines: 4000, retained_previews: 100, selected_events: 100, horizon_days: 90 });
const PREVIEW = 'calendar_import_preview_v1', SOURCE = 'calendar_busy_source_v1';
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const identifier = value => { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); };
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
function object(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const props = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in props[key]) || !props[key].enumerable)
    || required.some(key => !Object.hasOwn(props, key))) fail();
}
function text(value, maximum = 500, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value) > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(); return value;
}
function filename(value) { text(value, 200); if (!/\.ics$/i.test(value) || /[\/\\:\r\n]/.test(value) || value === '.ics') fail(); return value; }
function privateCopy(raw) {
  let nodes=0; const visiting=new Set();
  function visit(value,depth) {
    if(++nodes>10000 || depth>12) fail('BUDGET_EXCEEDED');
    if(value===null || typeof value==='string' || typeof value==='boolean' || (typeof value==='number'&&Number.isFinite(value))) return value;
    if(!value || typeof value!=='object' || visiting.has(value))fail(); visiting.add(value);const props=Object.getOwnPropertyDescriptors(value);let result;
    if(Array.isArray(value)){if(value.length>2000 || Reflect.ownKeys(props).some(key=>key!=='length'&&(typeof key!=='string'||! /^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length||!('value'in props[key])||!props[key].enumerable)))fail();result=Array.from({length:value.length},(_,i)=>{if(!Object.hasOwn(props,String(i)))fail();return visit(props[i].value,depth+1);});}
    else {if(Object.getPrototypeOf(value)!==Object.prototype || Reflect.ownKeys(props).some(key=>typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)||!('value'in props[key])||!props[key].enumerable))fail();result=Object.fromEntries(Object.keys(props).map(key=>[key,visit(props[key].value,depth+1)]));}
    visiting.delete(value);return result;
  }
  const result=visit(raw,0);if(Buffer.byteLength(JSON.stringify(result))>20000)fail('BUDGET_EXCEEDED');return result;
}
function scope(value) { object(value, ['start', 'end']); lifeStamp(value.start); lifeStamp(value.end); if (value.start >= value.end || Date.parse(value.end) - Date.parse(value.start) > 90 * 86400000) fail(); return structuredClone(value); }
function indexes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail(); const props=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(props).some(key=>key!=='length'&&(typeof key!=='string'||! /^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length||!('value'in props[key])||!props[key].enumerable)))fail();
  const result=Array.from({length:value.length},(_,i)=>{if(!Object.hasOwn(props,String(i)))fail();const item=props[i].value;if(!Number.isSafeInteger(item)||item<0||item>=100)fail();return item;});if(new Set(result).size!==result.length)fail();return result.sort((a,b)=>a-b);
}
function day(value) {
  if (!/^\d{8}$/.test(value)) fail(); const date = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  lifeDate(date); if (date < '2000-01-01' || date > '2100-12-31') fail('UNSUPPORTED'); return date;
}
const formatter = zone => new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function wall(format, at) { const parts = format.formatToParts(at); const get = type => Number(parts.find(p => p.type === type).value); return [get('year'),get('month'),get('day'),get('hour'),get('minute'),get('second')]; }
/** Modern IANA dates only. Collect observed offsets around the target, then require
 * exactly one precise midnight round trip. Gaps/folds never choose an offset. */
export function calendarMidnight(date, timezone) {
  lifeDate(date); if (date < '2000-01-01' || date > '2100-12-31') fail('UNSUPPORTED'); text(timezone,100); lifeTimezone(timezone);
  const target = Date.parse(`${date}T00:00:00.000Z`), format = formatter(timezone), offsets = new Set(), matches = new Set();
  for (let at = target - 36 * 3600000; at <= target + 36 * 3600000; at += 3600000) {
    const p = wall(format, at); offsets.add(Date.UTC(p[0],p[1]-1,p[2],p[3],p[4],p[5]) - at);
  }
  const expected = `${date}T00:00:00`;
  for (const offset of offsets) { const at = target-offset, p = wall(format, at), actual = `${String(p[0]).padStart(4,'0')}-${String(p[1]).padStart(2,'0')}-${String(p[2]).padStart(2,'0')}T${String(p[3]).padStart(2,'0')}:${String(p[4]).padStart(2,'0')}:${String(p[5]).padStart(2,'0')}`; if (actual === expected) matches.add(at); }
  if (matches.size !== 1) fail('UNSUPPORTED'); return new Date([...matches][0]).toISOString();
}
function utc(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value)) fail('UNSUPPORTED'); const date = day(value.slice(0,8));
  return lifeStamp(`${date}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`);
}
function splitQuoted(value, separator) {
  const pieces = []; let start = 0, quoted = false;
  for (let i=0;i<value.length;i++) { if (value[i] === '"') quoted = !quoted; else if (value[i] === separator && !quoted) { pieces.push(value.slice(start,i)); start=i+1; } }
  if (quoted) fail(); pieces.push(value.slice(start)); return pieces;
}
function property(line) {
  let quoted = false, colon = -1;
  for (let i=0;i<line.length;i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ':' && !quoted) { colon=i; break; } }
  if (colon < 1 || quoted) fail(); const [rawName,...parameters] = splitQuoted(line.slice(0,colon), ';'), name = rawName.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) fail(); const params = {};
  for (const parameter of parameters) { const at=parameter.indexOf('='), key=parameter.slice(0,at).toUpperCase(); let value=parameter.slice(at+1); if (at<1 || !/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params,key) || !value) fail(); if (value.startsWith('"')) { if (!value.endsWith('"') || value.length<2) fail(); value=value.slice(1,-1); } else if (value.includes('"')) fail(); params[key]=value; }
  return { name, params, value: line.slice(colon+1) };
}
function icsText(value) { return text(value.replace(/\\([nN,;\\])/g, (_,char) => /[nN]/.test(char) ? '\n' : char), 1000, true); }

export function parseCalendarFile({ filename: name, content, timezone }) {
  filename(name); text(content, CALENDAR_IMPORT_LIMITS.file_bytes); text(timezone,100); lifeTimezone(timezone);
  if (content.includes('\r') && content.replaceAll('\r\n','').includes('\r')) fail();
  const physical=content.replace(/^\uFEFF/,'').split(/\r?\n/); if (physical.length>4000) fail('BUDGET_EXCEEDED');
  if (physical.at(-1)==='') physical.pop(); const lines=[];
  for (const line of physical) { if (/^[ \t]/.test(line)) { if (!lines.length) fail(); lines[lines.length-1]+=line.slice(1); } else { if (!line) fail(); lines.push(line); } }
  const stack=[], events=[], components=[]; let root=null, count=0;
  for (const line of lines) {
    const prop=property(line);
    if (prop.name==='BEGIN') { if (Object.keys(prop.params).length || !/^[A-Z0-9-]+$/.test(prop.value) || ++count>200 || stack.length>=8) fail(); const node={ name:prop.value, properties:[], children:[] }; if (!stack.length) { if (root || node.name!=='VCALENDAR') fail(); root=node; } else stack.at(-1).children.push(node); stack.push(node); }
    else if (prop.name==='END') { if (Object.keys(prop.params).length || !stack.length || stack.at(-1).name!==prop.value) fail(); stack.pop(); }
    else { if (!stack.length) fail(); stack.at(-1).properties.push(prop); }
  }
  if (stack.length || !root) fail();
  const one = (node,key,required=false) => { const values=node.properties.filter(p=>p.name===key); if (values.length>1 || (required && values.length!==1)) fail(); return values[0] ?? null; };
  if (one(root,'VERSION',true).value!=='2.0' || !text(one(root,'PRODID',true).value,1000)) fail();
  const method=one(root,'METHOD')?.value.toUpperCase(); const omitted=[], uids=new Map(), midnightCache=new Map();
  const midnight=date => { if (!midnightCache.has(date)) midnightCache.set(date,calendarMidnight(date,timezone)); return midnightCache.get(date); };
  for (const node of root.children) {
    if (node.name!=='VEVENT') { components.push({ component:node.name, reason:'unsupported_component_not_imported' }); continue; }
    if (events.length+omitted.length>=100) fail('BUDGET_EXCEEDED'); const index=events.length+omitted.length;
    const titleProp=one(node,'SUMMARY'), title=titleProp ? icsText(titleProp.value) || '(Untitled event)' : '(Untitled event)';
    const uidProp=one(node,'UID',true), uid=text(uidProp.value,1000), reasons=[];
    if (uidProp.params && Object.keys(uidProp.params).length) reasons.push('uid_parameters_unsupported');
    if (method && method!=='PUBLISH') reasons.push('calendar_method_unsupported');
    if (node.children.length) reasons.push('nested_components_unsupported');
    if (node.properties.some(p=>['RRULE','RDATE','EXDATE','EXRULE','RECURRENCE-ID'].includes(p.name))) reasons.push('recurrence_not_supported');
    const status=one(node,'STATUS')?.value.toUpperCase(), transparency=one(node,'TRANSP')?.value.toUpperCase();
    if (status && !['CONFIRMED','TENTATIVE'].includes(status)) reasons.push('cancelled_or_unknown_status');
    if (transparency && transparency!=='OPAQUE') reasons.push('transparent_or_unknown_transparency');
    const start=one(node,'DTSTART'), end=one(node,'DTEND'); if (!start || !end) reasons.push('explicit_start_and_exclusive_end_required');
    if (one(node,'DURATION')) reasons.push('duration_not_supported');
    let event=null;
    if (start && end) {
      if (Object.hasOwn(start.params,'TZID') || Object.hasOwn(end.params,'TZID')) reasons.push('tzid_not_supported');
      else if ([start,end].some(p=>Object.keys(p.params).some(key=>key!=='VALUE'))) reasons.push('time_parameters_unsupported');
      else try {
        const valueStart=start.params.VALUE?.toUpperCase() ?? 'DATE-TIME', valueEnd=end.params.VALUE?.toUpperCase() ?? 'DATE-TIME';
        if (valueStart!==valueEnd || !['DATE','DATE-TIME'].includes(valueStart)) reasons.push('mixed_or_unsupported_value_type');
        else if (valueStart==='DATE') { const first=day(start.value), last=day(end.value); if (first>=last) reasons.push('nonpositive_event_interval'); else event={ kind:'date', start:midnight(first), end:midnight(last), original_start:start.value, original_end:end.value, timezone }; }
        else { const first=utc(start.value), last=utc(end.value); if (first>=last) reasons.push('nonpositive_event_interval'); else event={ kind:'utc', start:first, end:last, original_start:start.value, original_end:end.value, timezone:'UTC' }; }
      } catch(error) { reasons.push(error.code==='UNSUPPORTED' ? 'floating_time_or_unsupported_date_or_midnight' : 'invalid_event_datetime'); }
    }
    const old=uids.get(uid); if (old) { reasons.push('duplicate_uid_ambiguous'); if (old.supported) { const prior=events.splice(events.findIndex(e=>e.index===old.index),1)[0]; omitted.push({ index:prior.index, uid:prior.uid, title:prior.title, reasons:['duplicate_uid_ambiguous'] }); old.supported=false; } }
    if (reasons.length || !event) omitted.push({ index, uid, title, reasons:[...new Set(reasons)] });
    else events.push({ index, uid, title, ...event, end_semantics:'exclusive', source_properties_hash:workflowHash(node) });
    if (!old) uids.set(uid,{ index, supported:!reasons.length && !!event });
  }
  return { filename:name, file_sha256:sha(content), file_bytes:Buffer.byteLength(content), timezone, events:events.sort((a,b)=>a.index-b.index), omitted:omitted.sort((a,b)=>a.index-b.index), omitted_components:components, coverage:'partial_selected_file_snapshot', limitations:['Only explicit UTC or DATE start/end events are supported. DATE uses the chosen zone and uniquely resolved midnight.', 'DTEND is exclusive. Recurrence, TZID, floating times, nested components, transparent/cancelled events and durations are not imported.', 'This file does not prove current, complete or weekly calendar availability. URLs, attendees, descriptions and attachments are never fetched or expanded.'] };
}
const sourcePayload = data => { const { source_hash,...payload }=data; return payload; };
export function resolveCalendarBusySource(store, value) {
  object(value,['id','revision','version_hash']); identifier(value.id); revision(value.revision); hash(value.version_hash);
  const row=store.getWorkspaceRecord(value.id);
  if (!row || row.deleted_at || row.kind!=='artifact' || row.data.format!==SOURCE || row.revision!==1 || row.revision!==value.revision || workflowHash(row)!==value.version_hash) fail('REVISION_CONFLICT');
  const d=row.data; object(d,['format','schema_version','state','filename','file_sha256','preview_id','preview_hash','selected_indexes','selected_events','scope','timezone','busy','coverage','accepted_at','reviewer','creation_key','selection_hash','source_hash']);
  if (d.schema_version!==1 || d.state!=='accepted' || d.reviewer!==store.identity.student_id || d.source_hash!==workflowHash(sourcePayload(d))) fail('VERSION_MISMATCH');
  filename(d.filename); hash(d.file_sha256); hash(d.preview_hash); identifier(d.preview_id); indexes(d.selected_indexes); scope(d.scope); lifeTimezone(d.timezone); lifeStamp(d.accepted_at);
  if (!Array.isArray(d.selected_events) || !d.selected_events.length || d.selected_events.length!==d.selected_indexes.length || !Array.isArray(d.busy) || !d.busy.length || d.busy.length>100 || d.coverage!=='partial_selected_file_snapshot') fail('VERSION_MISMATCH');
  if(d.selection_hash!==workflowHash({preview_id:d.preview_id,review_hash:d.preview_hash,selected_indexes:d.selected_indexes,scope:d.scope}) || typeof d.creation_key!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(d.creation_key))fail('VERSION_MISMATCH');
  const expected=d.selected_events.map((e,i)=>{ object(e,['index','uid','title','kind','start','end','original_start','original_end','timezone','end_semantics','source_properties_hash']);text(e.uid,1000);text(e.title,1000);hash(e.source_properties_hash);text(e.original_start,100);text(e.original_end,100);lifeTimezone(e.timezone);if(e.index!==d.selected_indexes[i]||!['utc','date'].includes(e.kind)||e.end_semantics!=='exclusive')fail('VERSION_MISMATCH'); lifeStamp(e.start); lifeStamp(e.end); if (e.start>=e.end) fail('VERSION_MISMATCH'); return { start:e.start<d.scope.start ? d.scope.start:e.start, end:e.end>d.scope.end ? d.scope.end:e.end, id:`calendar-${e.index}`, label:e.title.replace(/[\r\n\t]/g,' ').slice(0,500) || '(Untitled event)' }; }).filter(e=>e.start<e.end);
  if (expected.length!==d.selected_events.length || workflowHash(expected)!==workflowHash(d.busy)) fail('VERSION_MISMATCH'); return row;
}
export const calendarSourcePin = row => ({ id:row.id, revision:row.revision, version_hash:workflowHash(row) });

export function createCalendarImportService({ store, studentWorkspace, clock=Date.now }) {
  const stamp=()=>new Date(clock()).toISOString(), rows=format=>store.listWorkspaceRecords({kind:'artifact'}).filter(r=>r.data.format===format);
  const parsed=raw=>{ object(raw,['filename','content','timezone']); return parseCalendarFile(raw); };
  function checked(row) {
    if (!row || row.kind!=='artifact' || row.deleted_at || row.data.format!==PREVIEW) fail('SCOPE_DENIED'); const d=row.data;
    object(d,['format','state','request','parsed','review_hash','created_at','creation_key','receipt']); const result=parsed(d.request);
    if (!['preview','accepted'].includes(d.state) || workflowHash(result)!==workflowHash(d.parsed) || d.review_hash!==workflowHash({request:d.request,parsed:d.parsed}) || (d.state==='preview' && d.receipt!==null)) fail('VERSION_MISMATCH');
    if(d.state==='preview' && row.revision!==1)fail('VERSION_MISMATCH');
    if(d.state==='accepted'){object(d.receipt,['source_id','selection_hash','idempotency_key','reviewed_revision','reviewer','accepted_at']);identifier(d.receipt.source_id);hash(d.receipt.selection_hash);lifeStamp(d.receipt.accepted_at);if(row.revision!==2||d.receipt.reviewed_revision!==1||d.receipt.reviewer!==store.identity.student_id||typeof d.receipt.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(d.receipt.idempotency_key))fail('VERSION_MISMATCH');}
    return row;
  }
  const sourceView=row=>({ id:row.id, revision:row.revision, title:row.title, source_pin:calendarSourcePin(row), data:row.data });
  return {
    context:()=>({ timezone:store.identity.timezone, limits:CALENDAR_IMPORT_LIMITS, supported:'explicit UTC and DATE VEVENT only', advanced_recurrence:'unavailable', provider_writes:0, model_calls:0 }),
    preview(raw,{idempotencyKey}={}) {
      const result=parsed(raw); if (typeof idempotencyKey!=='string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail(); const previous=rows(PREVIEW).find(r=>r.data.creation_key===idempotencyKey);
      if (previous) { checked(previous); if (workflowHash(previous.data.request)!==workflowHash(raw)) fail('REVISION_CONFLICT'); return previous; }
      if(rows(PREVIEW).length>=100) fail('BUDGET_EXCEEDED'); const data={format:PREVIEW,state:'preview',request:structuredClone(raw),parsed:result,review_hash:workflowHash({request:raw,parsed:result}),created_at:stamp(),creation_key:idempotencyKey,receipt:null};
      return checked(store.createWorkspaceRecord({kind:'artifact',title:`Calendar file preview: ${raw.filename}`,data},{idempotencyKey}));
    },
    listPreviews:()=>rows(PREVIEW).map(checked),
    listSources:()=>rows(SOURCE).map(row=>sourceView(resolveCalendarBusySource(store,calendarSourcePin(row)))),
    getPreview:id=>checked(store.getWorkspaceRecord(identifier(id))),
    accept(id,raw,{idempotencyKey}={}) {
      object(raw,['expected_revision','review_hash','selected_indexes','scope','confirmed']); revision(raw.expected_revision); hash(raw.review_hash); const chosen=indexes(raw.selected_indexes), interval=scope(raw.scope);
      if(raw.confirmed!==true) fail('CONSENT_REQUIRED'); if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail(); let row=checked(store.getWorkspaceRecord(identifier(id))), d=row.data;
      if(raw.review_hash!==d.review_hash) fail('REVISION_CONFLICT'); const selection_hash=workflowHash({preview_id:row.id,review_hash:d.review_hash,selected_indexes:chosen,scope:interval});
      if(d.state==='accepted') { if(d.receipt.selection_hash!==selection_hash || d.receipt.idempotency_key!==idempotencyKey || ![d.receipt.reviewed_revision,row.revision].includes(raw.expected_revision)) fail('REVISION_CONFLICT'); const saved=store.getWorkspaceRecord(d.receipt.source_id); if(!saved || saved.deleted_at) fail('REVISION_CONFLICT'); return {preview:row,source:sourceView(resolveCalendarBusySource(store,calendarSourcePin(saved))),outcome:'replayed'}; }
      if(row.revision!==raw.expected_revision) fail('REVISION_CONFLICT'); const events=chosen.map(index=>d.parsed.events.find(e=>e.index===index)); if(events.some(e=>!e)) fail('SCOPE_DENIED');
      const busy=events.map(e=>({start:e.start<interval.start?interval.start:e.start,end:e.end>interval.end?interval.end:e.end,id:`calendar-${e.index}`,label:e.title.replace(/[\r\n\t]/g,' ').slice(0,500)||'(Untitled event)'})).filter(e=>e.start<e.end); if(!busy.length) fail('UNSUPPORTED');
      // Requiring every selected event to overlap makes omissions visible, rather
      // than silently accepting a checked event outside the reviewed horizon.
      if(busy.length!==events.length) fail('INVALID_INPUT'); const sourceId=randomUUID(), accepted_at=stamp();
      const source={format:SOURCE,schema_version:1,state:'accepted',filename:d.parsed.filename,file_sha256:d.parsed.file_sha256,preview_id:row.id,preview_hash:d.review_hash,selected_indexes:chosen,selected_events:events,scope:interval,timezone:d.parsed.timezone,busy,coverage:'partial_selected_file_snapshot',accepted_at,reviewer:store.identity.student_id,creation_key:idempotencyKey,selection_hash,source_hash:''}; source.source_hash=workflowHash(sourcePayload(source));
      const receipt={source_id:sourceId,selection_hash,idempotency_key:idempotencyKey,reviewed_revision:row.revision,reviewer:store.identity.student_id,accepted_at};
      const batch=store.commitWorkspaceBatch({creates:[{id:sourceId,kind:'artifact',title:`Selected calendar busy times: ${d.parsed.filename}`,data:source}],updates:[{id:row.id,expected_revision:row.revision,data:{...d,state:'accepted',receipt}}]});
      row=checked(batch.updates[0]); return {preview:row,source:sourceView(resolveCalendarBusySource(store,calendarSourcePin(batch.creates[0]))),outcome:'accepted',verification:'atomic_selected_busy_source_readback',provider_writes:0,model_calls:0};
    },
    forget(id,raw) { object(raw,['expected_revision','version_hash','confirmed']); if(raw.confirmed!==true) fail('CONSENT_REQUIRED'); const row=resolveCalendarBusySource(store,{id:identifier(id),revision:raw.expected_revision,version_hash:raw.version_hash}); return store.deleteWorkspaceRecord(row.id,row.revision); },
    async plan(raw,{idempotencyKey,signal,authorize}={}) {
      raw=privateCopy(raw);
      object(raw,['calendar_source','availability','timezone','horizonEnd','maxDailyMinutes','bufferMinutes','minBlockMinutes'],['calendar_source','availability','timezone','horizonEnd','maxDailyMinutes','bufferMinutes','minBlockMinutes']);
      if(!studentWorkspace) fail('UNSUPPORTED'); if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail();
      const previous=store.listRuns().find(run=>run.recipe_id==='plan.with_calendar' && run.input.request_key===idempotencyKey);
      if(previous) { const {now,request_key,...prior}=previous.input; if(workflowHash(prior)!==workflowHash(raw)) fail('REVISION_CONFLICT'); }
      const run=studentWorkspace.runner.prepare('plan.with_calendar',{...structuredClone(raw),now:previous?.input.now ?? stamp(),request_key:idempotencyKey},{idempotencyKey});
      const result=await studentWorkspace.runner.execute(run.id,{signal,authorize}); const plans=studentWorkspace.listPlans().filter(row=>row.data.run_id===result.id); return {run:result,plan:plans[0]??null,calendar_scope:'partial_selected_busy_snapshot',provider_writes:0};
    },
  };
}
