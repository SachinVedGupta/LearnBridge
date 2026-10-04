import {redirect} from 'next/navigation';
import {AppError,requireUser} from '@/lib/server/auth';
import RemoteCompanion from './RemoteCompanion';

export const dynamic='force-dynamic';
export const metadata={title:'Your computer · LearnBridge'};
export default async function RemotePage(){
 try{await requireUser();}catch(error){if(error instanceof AppError&&error.status===401)redirect('/login?next=%2Fremote');throw error;}
 const enabled=process.env.REMOTE_COMPANION_ENABLED==='true'&&process.env.REMOTE_COMPANION_RELEASE_GATE==='status_only_verified_policy';
 const resultsEnabled=enabled&&process.env.REMOTE_COMPANION_RESULT_RELEASE_GATE==='reviewed_text_verified_policy';
 return <main className="mx-auto max-w-3xl p-6 py-12"><p className="text-sm text-teal-300">Your computer, with your permission</p><h1 className="my-4 text-4xl font-semibold">Study from your phone</h1>
  <p className="mb-6 leading-7 text-slate-300">Pair your own local LearnBridge workspace to send a study question. Your computer uses its separately approved source selection. An answer becomes available here only after you review its writing draft on the computer and explicitly share that exact text.</p>
  <RemoteCompanion enabled={enabled} resultsEnabled={resultsEnabled}/>
 </main>;
}
