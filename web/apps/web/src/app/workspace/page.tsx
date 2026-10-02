'use client';

import { useState, useEffect, useRef } from 'react';
import {loadState,saveState} from '@/lib/cloud-state';
import Editor from '@/components/Editor';
import Sidebar, { type Mode } from '@/components/Sidebar';
import type { Editor as TipTapEditor } from '@tiptap/react';

export default function Home() {
  const [editor, setEditor] = useState<TipTapEditor | null>(null);
  const [askResponse, setAskResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [courseCtx, setCourseCtx] = useState('');
  const [mode, setMode] = useState<Mode>('ask');
  const [docTitle, setDocTitle] = useState('Untitled Document');
  const [saveStatus, setSaveStatus] = useState('Loading your cloud draft…');
  const [restored, setRestored] = useState(false);
  const changes=useRef(0);
  const [revision,setRevision]=useState(0);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    if(!editor)return;
    let alive=true;editor.setEditable(false);
    loadState('draft').then(d=>{
      if(!alive)return;
      if(d.value?.content)editor.commands.setContent(d.value.content);
      if(typeof d.value?.title==='string')setDocTitle(d.value.title);
      if(typeof d.value?.context==='string')setCourseCtx(d.value.context);
      setRevision(d.revision);setRestored(true);setSaveStatus('Cloud draft loaded');editor.setEditable(true);
    }).catch(e=>setSaveStatus(e.message));
    return()=>{alive=false;};
  },[editor]);
  useEffect(()=>{if(!editor||!restored)return;const dirty=()=>{changes.current++;setSaveStatus('Unsaved changes');};editor.on('update',dirty);return()=>{editor.off('update',dirty);};},[editor,restored]);
  async function saveDraft(){if(!editor||!restored||saving)return;setSaving(true);const savingVersion=changes.current;try{const next=await saveState('draft',{content:editor.getJSON(),title:docTitle,context:courseCtx},revision);setRevision(next);setSaveStatus(changes.current===savingVersion?'Saved to your account':'Unsaved changes');}catch(e){setSaveStatus(e instanceof Error?e.message:'Save failed.');}finally{setSaving(false);}}

  const handleEditorReady = (editorInstance: TipTapEditor) => {
    setEditor(editorInstance);
  };

  const handleAskResponse = (text: string) => {
    setAskResponse(text);
  };

  const handleLoadingChange = (isLoading: boolean) => {
    setLoading(isLoading);
  };

  return (
    <main className="min-h-screen flex flex-col bg-gradient-to-br from-gray-950 via-black to-gray-950 p-4 text-gray-100 md:p-6">
      <header className="mb-4 rounded-2xl border border-gray-800/80 bg-gray-900/80 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur">
        <div className="grid gap-3 lg:grid-cols-[auto,1fr,auto] lg:items-center">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Assignment workspace</h1>
          </div>

          <div className="flex flex-col items-center gap-3 lg:flex-row lg:items-center lg:justify-center lg:gap-6">
            <label className="mx-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-2 text-sm shadow-inner shadow-black/30 focus-within:border-blue-500/70 focus-within:ring-2 focus-within:ring-blue-500/30">
              <span className="text-xs uppercase tracking-wide text-gray-500">Document</span>
              <input
                type="text"
                value={docTitle}
                maxLength={500}
                onChange={(event) => {setDocTitle(event.target.value);changes.current++;setSaveStatus('Unsaved changes');}}
                className="flex-1 bg-transparent text-base font-medium text-gray-100 placeholder-gray-500 focus:outline-none"
                placeholder="Untitled document"
              />
            </label>
          </div>

          <p role="status" className="text-sm text-slate-400">{saveStatus}</p><button onClick={saveDraft} disabled={!restored||saving} className="mt-2 rounded-lg bg-teal-700 px-4 py-2 disabled:opacity-40">{saving?'Saving…':'Save draft'}</button>
        </div>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr),minmax(0,1fr)] md:gap-6">
        <div className="flex min-h-0 flex-col overflow-visible">
          <Editor onEditorReady={handleEditorReady} />
        </div>

        <div className="flex min-h-0 flex-col overflow-visible">
          <Sidebar
            response={askResponse}
            loading={loading}
            editor={editor}
            onAskResponse={handleAskResponse}
            onLoadingChange={handleLoadingChange}
            courseCtx={courseCtx}
            onCourseCtxChange={value=>{setCourseCtx(value);changes.current++;setSaveStatus('Unsaved changes');}}
            mode={mode}
            onModeChange={setMode}
          />
        </div>
      </div>
    </main>
  );
}
