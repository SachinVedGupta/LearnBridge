export async function loadState(kind:'tasks'|'draft'){
 const r=await fetch('/api/state/'+kind,{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error);return d as {value:any;revision:number};
}
export async function saveState(kind:'tasks'|'draft',value:unknown,revision:number){
 const r=await fetch('/api/state/'+kind,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value,revision})});const d=await r.json();if(!r.ok)throw Error(d.error);return d.revision as number;
}
