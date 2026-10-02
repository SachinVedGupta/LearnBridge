'use client';
import {useEffect,useState} from 'react';

type Connector={id:string;name:string;canRead:boolean;accounts:Array<{id:string;label:string;status:string}>};
export type SelectedSource={provider:string;accountId:string};

export default function ConnectedSourcesPicker({value,onChange}:{value:SelectedSource[];onChange:(next:SelectedSource[])=>void}){
 const [items,setItems]=useState<Connector[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{let active=true;fetch('/api/connections',{cache:'no-store'}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load connections.');if(active)setItems(data.connectors||[]);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load connections.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 function toggle(provider:string,accountId:string){const existing=value.find(x=>x.provider===provider);if(existing){onChange(value.filter(x=>x.provider!==provider));return;}if(value.length>=5){setError('Choose up to five accounts per question.');return;}setError('');onChange([...value,{provider,accountId}]);}
 const usable=items.filter(x=>x.canRead&&x.accounts.some(a=>a.status==='ACTIVE'));
 return <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-4" aria-label="Connected sources">
  <div className="flex items-start justify-between gap-3"><div><h2 className="font-medium">Use connected sources</h2><p className="mt-1 text-xs text-slate-400">Selected apps may be searched for this question only. Nothing is shared by default.</p></div><span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300">{value.length}/5</span></div>
  {loading?<p className="mt-3 text-sm text-slate-400">Loading your connections…</p>:usable.length?<div className="mt-3 grid gap-2 sm:grid-cols-2">{usable.map(app=>app.accounts.filter(a=>a.status==='ACTIVE').map(account=>{const checked=value.some(x=>x.provider===app.id&&x.accountId===account.id);return <label key={`${app.id}:${account.id}`} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${checked?'border-teal-500/70 bg-teal-950/30':'border-slate-700 bg-slate-950/40 hover:border-slate-500'}`}><input type="checkbox" checked={checked} onChange={()=>toggle(app.id,account.id)} aria-label={`Use ${app.name} account ${account.label}`} className="accent-teal-400"/><span className="min-w-0"><span className="block font-medium">{app.name}</span><span className="block truncate text-xs text-slate-400">{account.label}</span></span></label>;}))}</div>:<p className="mt-3 text-sm text-slate-400">No connected apps are ready for tutor search yet. Connect an app that supports reading in Connections.</p>}
  {error&&<p role="alert" className="mt-2 text-xs text-amber-300">{error}</p>}
 </section>;
}
