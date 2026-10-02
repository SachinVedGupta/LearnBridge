'use client';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { AcademicCapIcon, ChartBarSquareIcon, ChevronDownIcon, ChevronUpIcon, SquaresPlusIcon, } from '@heroicons/react/24/outline';
import { PaperAirplaneIcon } from '@heroicons/react/24/solid';
import { askAPI, editAPI } from '@/lib/api';
import type { Editor } from '@tiptap/react';
import { mapSuggestionsToAbsolute } from '@/extensions/InlineSuggestions';
import type { MappedSuggestion } from '@assignment-ai/shared';
import { templates } from '@/lib/templates';
import { analyzeText, type WritingStats } from '@/lib/analytics';
import Analytics from './Analytics';
import ConnectedSourcesPicker, {type SelectedSource} from './ConnectedSourcesPicker';
export type Mode = 'ask' | 'agent';
interface SidebarProps {
    response: string | null;
    loading: boolean;
    editor: Editor | null;
    onAskResponse: (text: string) => void;
    onLoadingChange: (loading: boolean) => void;
    courseCtx: string;
    onCourseCtxChange: (text: string) => void;
    mode: Mode;
    onModeChange: (mode: Mode) => void;
}
export default function Sidebar({ response, loading, editor, onAskResponse, onLoadingChange, courseCtx, onCourseCtxChange, mode, onModeChange, }: SidebarProps) {
    const [instructions, setInstructions] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [showCourseCtx, setShowCourseCtx] = useState(false);
    const [showTemplates, setShowTemplates] = useState(false);
    const [showAnalytics, setShowAnalytics] = useState(false);
    const [showSources, setShowSources] = useState(false);
    const [selectedSources, setSelectedSources] = useState<SelectedSource[]>([]);
    const [agentSuggestions, setAgentSuggestions] = useState<MappedSuggestion[]>([]);
    const [confirmModal, setConfirmModal] = useState<{
        show: boolean;
        templateId: string | null;
    }>({
        show: false,
        templateId: null,
    });
    const [savedSelection, setSavedSelection] = useState<{
        from: number;
        to: number;
    } | null>(null);
    const [stats, setStats] = useState<WritingStats>({
        wordCount: 0,
        charCount: 0,
        charCountNoSpaces: 0,
        sentenceCount: 0,
        paragraphCount: 0,
        avgSentenceLength: 0,
        readingTimeMinutes: 0,
        readabilityScore: 0,
        readabilityLevel: 'N/A',
        vocabularyDiversity: 0,
    });
    const modeOptions: Array<{
        id: Mode;
        label: string;
    }> = [
        { id: 'ask', label: 'Ask' },
        { id: 'agent', label: 'Agent' },
    ];
    const summaryMetrics = [
        {
            label: 'Words',
            value: stats.wordCount.toLocaleString(),
        },
        {
            label: 'Reading Time',
            value: stats.wordCount === 0
                ? '—'
                : `${Math.max(1, Math.round(stats.readingTimeMinutes || 0))} min`,
        },
        {
            label: 'Readability',
            value: stats.readabilityLevel,
        },
    ];
    const toggleButtonClasses = (active: boolean, accent: 'blue' | 'indigo' = 'blue') => {
        const activeAccent = accent === 'indigo'
            ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-100 shadow-[0_0_0_1px_rgba(129,140,248,0.25)] focus:ring-indigo-500/30'
            : 'border-blue-500/60 bg-blue-500/10 text-blue-100 shadow-[0_0_0_1px_rgba(59,130,246,0.25)] focus:ring-blue-500/30';
        const inactiveAccent = accent === 'indigo' ? 'focus:ring-indigo-500/30' : 'focus:ring-blue-500/30';
        return [
            'flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-0',
            active
                ? activeAccent
                : `border-gray-800 bg-gray-900/80 text-gray-300 hover:border-gray-600 hover:bg-gray-800/80 ${inactiveAccent}`,
        ].join(' ');
    };
    const toggleTemplatesPanel = () => {
        if (showTemplates) {
            setShowTemplates(false);
        }
        else {
            setShowTemplates(true);
            setShowCourseCtx(false);
        }
    };
    const toggleCourseCtxPanel = () => {
        if (showCourseCtx) {
            setShowCourseCtx(false);
        }
        else {
            setShowCourseCtx(true);
            setShowTemplates(false);
        }
    };
    const updateLoading = (isLoading: boolean) => {
        onLoadingChange(isLoading);
    };
    // Update analytics when editor content changes (debounced)
    useEffect(() => {
        if (!editor)
            return;
        const updateAnalytics = () => {
            const text = editor.getText();
            const newStats = analyzeText(text);
            setStats(newStats);
        };
        // Initial update
        updateAnalytics();
        // Debounce subsequent updates
        let timeoutId: NodeJS.Timeout;
        const handleUpdate = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(updateAnalytics, 500);
        };
        editor.on('update', handleUpdate);
        return () => {
            editor.off('update', handleUpdate);
            clearTimeout(timeoutId);
        };
    }, [editor]);
    const handleAsk = async () => {
        if (!editor)
            return;
        if (!instructions.trim()) {
            setError('Please enter a question');
            return;
        }
        updateLoading(true);
        setError(null);
        setAgentSuggestions([]); // Clear any agent suggestions
        onAskResponse(''); // Clear old response
        try {
            const docText = editor.getText();
            const result = await askAPI({
                docSlice: docText,
                instructions: instructions,
                courseCtx: courseCtx || undefined,
                selectedSources,
            });
            onAskResponse(result.assistant_text);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to get response');
        }
        finally {
            updateLoading(false);
        }
    };
    const handleAgent = async () => {
        if (!editor)
            return;
        if (!instructions.trim()) {
            setError('Please enter brief instructions for suggestions');
            return;
        }
        // Use saved selection, current selection, or entire document
        let from: number;
        let to: number;
        if (savedSelection) {
            // Use the selection saved before focus was lost
            from = savedSelection.from;
            to = savedSelection.to;
        }
        else {
            // Check current selection
            const selection = editor.state.selection;
            from = selection.from;
            to = selection.to;
            // If nothing selected, use entire document
            if (from === to) {
                from = 0;
                to = editor.state.doc.content.size;
            }
        }
        updateLoading(true);
        setError(null);
        setAgentSuggestions([]); // Clear old suggestions
        onAskResponse(''); // Clear old response text
        try {
            const selectedText = editor.state.doc.textBetween(from, to, '\n');
            const result = await editAPI({
                docSlice: selectedText,
                range: { from, to },
                instructions: instructions,
                courseCtx: courseCtx || undefined,
            });
            // Map suggestion ranges (relative to selection) to absolute positions
            if (Array.isArray(result.suggestions) && result.suggestions.length > 0) {
                const mapped = mapSuggestionsToAbsolute(result.suggestions, from, editor);
                editor.commands.setSuggestions(mapped, from);
                setAgentSuggestions(mapped);
                // Show summary of changes
                if (result.summary) {
                    onAskResponse(`✨ ${result.summary}\n\nClick on the highlighted suggestions in the editor to review and apply them.`);
                }
                else {
                    onAskResponse(`✨ Generated ${mapped.length} suggestion${mapped.length !== 1 ? 's' : ''}.\n\nClick on the highlighted suggestions in the editor to review and apply them.`);
                }
            }
            else {
                onAskResponse('No suggestions were generated. Try being more specific with your instructions.');
            }
            // Clear saved selection after use
            setSavedSelection(null);
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to generate content';
            setError(errorMessage);
            onAskResponse(`❌ Error: ${errorMessage}\n\nPlease check the API server logs for details.`);
        }
        finally {
            updateLoading(false);
        }
    };
    const acceptSuggestion = (id: string) => {
        editor?.commands.acceptSuggestion(id);
        setAgentSuggestions(prev => prev.filter(s => s.id !== id));
    };
    const rejectSuggestion = (id: string) => {
        editor?.commands.rejectSuggestion(id);
        setAgentSuggestions(prev => prev.filter(s => s.id !== id));
    };
    const acceptAll = () => {
        if (!editor || agentSuggestions.length === 0)
            return;
        // Sort by position descending to avoid offset issues
        const sorted = [...agentSuggestions].sort((a, b) => b.absoluteFrom - a.absoluteFrom);
        for (const s of sorted) {
            editor.commands.acceptSuggestion(s.id);
        }
        setAgentSuggestions([]);
    };
    const rejectAll = () => {
        if (!editor || agentSuggestions.length === 0)
            return;
        for (const s of agentSuggestions) {
            editor.commands.rejectSuggestion(s.id);
        }
        setAgentSuggestions([]);
    };
    const handleSubmit = async () => {
        if (mode === 'ask') {
            await handleAsk();
        }
        else {
            await handleAgent();
        }
        setInstructions('');
        setError(null);
    };
    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };
    const handleInputFocus = () => {
        // Save current selection when user focuses on input in Agent mode
        if (editor && mode === 'agent') {
            const { from, to } = editor.state.selection;
            if (from !== to) {
                setSavedSelection({ from, to });
            }
        }
    };
    const handleTemplateSelect = (templateId: string) => {
        if (!editor)
            return;
        // Check if editor has content
        const currentContent = editor.getText().trim();
        if (currentContent && currentContent.length > 0) {
            // Show confirmation modal
            setConfirmModal({ show: true, templateId });
        }
        else {
            // No content, apply template directly
            applyTemplate(templateId);
        }
    };
    const applyTemplate = (templateId: string) => {
        if (!editor)
            return;
        const template = templates.find(t => t.id === templateId);
        if (!template)
            return;
        // Clear editor and insert template
        editor.commands.setContent(template.content);
        editor.commands.focus();
        setShowTemplates(false);
        setConfirmModal({ show: false, templateId: null });
    };
    const handleConfirmTemplate = () => {
        if (confirmModal.templateId) {
            applyTemplate(confirmModal.templateId);
        }
    };
    const handleCancelTemplate = () => {
        setConfirmModal({ show: false, templateId: null });
    };
    const templatesButtonRef = useRef<HTMLButtonElement | null>(null);
    const contextButtonRef = useRef<HTMLButtonElement | null>(null);
    return (<div className="flex h-full min-h-0 flex-col overflow-visible rounded-2xl border border-gray-800/70 bg-gray-900/85 shadow-[0_18px_45px_rgba(10,14,32,0.6)]">
      {/* Header */}
      <div className="border-b border-gray-800/70 bg-gray-900/80 px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-100">
          <span className="text-xl">🤖</span>
          AI Assistant
        </h2>
      </div>
      
      {/* Messages Area */}
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {summaryMetrics.map((metric) => (<div key={metric.label} className="rounded-2xl border border-gray-800 bg-gray-950/60 px-3 py-3 text-center shadow-inner shadow-black/20">
              <p className="text-xs uppercase tracking-wide text-gray-500">{metric.label}</p>
              <p className="mt-1 text-lg font-semibold text-gray-100">{metric.value}</p>
            </div>))}
        </div>

        {/* Analytics Section */}
        <div className="space-y-3">
          <button onClick={() => setShowAnalytics(!showAnalytics)} className={toggleButtonClasses(showAnalytics)}>
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
                <ChartBarSquareIcon className="h-5 w-5"/>
              </span>
              <span className="flex flex-col items-start">
                <span>Writing Stats</span>
                <span className="text-xs font-normal text-gray-400">
                  {showAnalytics ? 'Hide analytics panel' : 'View live progress'}
                </span>
              </span>
            </span>
            {showAnalytics ? (<ChevronUpIcon className="h-5 w-5 text-blue-300"/>) : (<ChevronDownIcon className="h-5 w-5 text-gray-500"/>)}
          </button>
          {showAnalytics && <Analytics stats={stats}/>}
        </div>

        {loading && (<div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <p className="text-sm text-gray-400">Thinking...</p>
            </div>
          </div>)}
        
        {!loading && response && (<div className="bg-gray-800 rounded-lg border border-gray-700 p-4 shadow-sm">
            <div className="prose prose-invert prose-sm max-w-none">
              <div className="whitespace-pre-wrap text-gray-200 text-sm leading-relaxed">{response}</div>
            </div>
            {/* Suggestion actions (contextual) */}
            {agentSuggestions.length > 0 && (<div className="mt-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs text-gray-400">Apply suggestions:</span>
                  <button onClick={acceptAll} className="text-xs px-2 py-1 rounded bg-green-700 text-white hover:bg-green-600">Accept All</button>
                  <button onClick={rejectAll} className="text-xs px-2 py-1 rounded bg-red-700 text-white hover:bg-red-600">Reject All</button>
                </div>
                <ul className="space-y-2">
                  {agentSuggestions.map(s => (<li key={s.id} className="bg-gray-900 border border-gray-700 rounded p-2 text-xs text-gray-200">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="text-gray-400 mb-1">
                            Replace [{s.absoluteFrom}..{s.absoluteTo}]
                            {s.stale && <span className="ml-2 text-red-400">(stale)</span>}
                            {s.severity && <span className="ml-2 text-blue-400">({s.severity})</span>}
                          </div>
                          <div className="flex flex-col gap-1">
                            <div><span className="bg-red-900/60 px-1 rounded">{s.original}</span></div>
                            <div><span className="bg-green-900/60 px-1 rounded">{s.replacement}</span></div>
                            {s.reason && <div className="text-gray-500">{s.reason}</div>}
                            {s.confidence !== undefined && (<div className="text-gray-500">Confidence: {(s.confidence * 100).toFixed(0)}%</div>)}
                          </div>
                        </div>
                        <div className="flex-shrink-0 flex gap-2">
                          <button onClick={() => acceptSuggestion(s.id)} disabled={s.stale} className="px-2 py-1 rounded bg-green-700 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed">
                            Accept
                          </button>
                          <button onClick={() => rejectSuggestion(s.id)} className="px-2 py-1 rounded bg-red-700 text-white hover:bg-red-600">
                            Reject
                          </button>
                        </div>
                      </div>
                    </li>))}
                </ul>
              </div>)}
          </div>)}
        
        {!loading && !response && (<div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="text-6xl mb-4">💬</div>
            <p className="text-gray-300 text-sm mb-2 font-medium">
              Ready to help!
            </p>
            <p className="text-gray-500 text-xs max-w-xs">
              Ask me questions about your assignment or select text to improve it with Agent mode.
            </p>
          </div>)}
      </div>

      {/* Chat Input Area */}
      <div className="mt-auto border-t border-gray-700/80 bg-gray-800/95 p-4">
        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-800 bg-gray-900/80 p-3 shadow-inner shadow-black/20">
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto pb-1">
                <div className="flex min-w-max items-center gap-2">
                  <div className="inline-flex flex-none items-center gap-1 rounded-full border border-gray-800 bg-gray-950/60 p-1 shadow-inner shadow-black/30">
                    {modeOptions.map((option) => {
            const isActive = option.id === mode;
            return (<button key={option.id} type="button" onClick={() => onModeChange(option.id)} disabled={loading} className={[
                    'rounded-full px-4 py-[6px] text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60',
                    isActive
                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-600/30'
                        : 'text-gray-400 hover:text-gray-200',
                ].join(' ')}>
                          {option.label}
                        </button>);
        })}
                  </div>

                  <div className="relative flex-none">
                    <button type="button" onClick={toggleTemplatesPanel} ref={templatesButtonRef} className="flex flex-none items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2 text-sm font-medium text-gray-200 shadow-inner shadow-black/20 transition hover:border-blue-500/50 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
                        <SquaresPlusIcon className="h-4 w-4"/>
                      </span>
                      <span>Templates</span>
                      {showTemplates ? (<ChevronUpIcon className="h-4 w-4 text-blue-300"/>) : (<ChevronDownIcon className="h-4 w-4 text-gray-500"/>)}
                    </button>

                    {showTemplates && (<TemplatesMenu anchorRef={templatesButtonRef} loading={loading} onSelect={handleTemplateSelect}/>)}
                  </div>

                  <div className="relative flex-none">
                    <button type="button" onClick={toggleCourseCtxPanel} ref={contextButtonRef} className="flex flex-none items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2 text-sm font-medium text-gray-200 shadow-inner shadow-black/20 transition hover:border-indigo-500/50 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-60">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
                        <AcademicCapIcon className="h-4 w-4"/>
                      </span>
                      <span>Context</span>
                      {showCourseCtx ? (<ChevronUpIcon className="h-4 w-4 text-indigo-300"/>) : (<ChevronDownIcon className="h-4 w-4 text-gray-500"/>)}
                    </button>

                    {showCourseCtx && (<CourseContextMenu anchorRef={contextButtonRef} loading={loading} courseCtx={courseCtx} onCourseCtxChange={onCourseCtxChange}/>)}
                  </div>
                </div>
              </div>

              {mode==='ask'&&<div>
                <button type="button" aria-expanded={showSources} onClick={()=>setShowSources(v=>!v)} className="w-full rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-left text-sm text-gray-200 hover:border-teal-500/60">
                  {selectedSources.length?`Connected sources · ${selectedSources.length} selected`: 'Choose connected sources (optional)'}
                </button>
                {showSources&&<div className="mt-2"><ConnectedSourcesPicker value={selectedSources} onChange={setSelectedSources}/></div>}
              </div>}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <input type="text" value={instructions} onChange={(e) => setInstructions(e.target.value)} onKeyDown={handleKeyPress} onFocus={handleInputFocus} placeholder={mode === 'ask' ? 'Ask the assistant…' : 'Describe the changes you need…'} className="flex-1 rounded-xl border border-transparent bg-gray-950/40 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500/50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60" disabled={loading}/>

                <button onClick={handleSubmit} disabled={loading || !editor || !instructions.trim()} className="flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:from-blue-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-60">
                  {loading ? (<svg className="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>) : (<PaperAirplaneIcon className="h-5 w-5 -rotate-6"/>)}
                </button>
              </div>

              {error && (<div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200 shadow-inner shadow-red-900/20">
                  {error}
                </div>)}
            </div>
          </div>

          <div className="text-xs text-gray-500">
            {mode === 'ask' && 'Tip: Ask for feedback, clarity, or next steps on your assignment.'}
            {mode === 'agent' && 'Tip: Select text or leave blank to rewrite the entire document.'}
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmModal.show && (<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl max-w-md w-full p-6 transform transition-all">
            {/* Icon */}
            <div className="flex items-center justify-center w-12 h-12 mx-auto bg-yellow-500/10 rounded-full mb-4">
              <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
            </div>

            {/* Title */}
            <h3 className="text-lg font-semibold text-gray-100 text-center mb-2">
              Replace Current Content?
            </h3>

            {/* Message */}
            <p className="text-sm text-gray-400 text-center mb-6">
              This will replace your current content with the selected template. This action cannot be undone.
            </p>

            {/* Buttons */}
            <div className="flex gap-3">
              <button onClick={handleCancelTemplate} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-xl font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500">
                Cancel
              </button>
              <button onClick={handleConfirmTemplate} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500">
                Continue
              </button>
            </div>
          </div>
        </div>)}
    </div>);
}
const MENU_WIDTH = 288; // tailwind w-72
const MENU_OFFSET = 12;
const DEFAULT_MENU_HEIGHT = 320;
interface AnchorPosition {
    top: number;
    left: number;
    placement: 'top' | 'bottom';
}
function useAnchorPosition<T extends HTMLElement>(anchorRef: RefObject<T | null>, isOpen: boolean, menuHeight: number, offset = MENU_OFFSET) {
    const [position, setPosition] = useState<AnchorPosition | null>(null);
    useLayoutEffect(() => {
        if (!isOpen) {
            setPosition(null);
            return;
        }
        if (typeof window === 'undefined') {
            return;
        }
        const updatePosition = () => {
            const anchorEl = anchorRef.current;
            if (!anchorEl)
                return;
            const rect = anchorEl.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const estimatedHeight = menuHeight || DEFAULT_MENU_HEIGHT;
            const heightForPlacement = menuHeight || estimatedHeight;
            const spaceBelow = viewportHeight - rect.bottom;
            const spaceAbove = rect.top;
            const canOpenBelow = spaceBelow >= heightForPlacement + offset;
            const canOpenAbove = spaceAbove >= heightForPlacement + offset;
            let placement: 'top' | 'bottom' = 'bottom';
            if (!canOpenBelow && (canOpenAbove || spaceAbove > spaceBelow)) {
                placement = 'top';
            }
            const maxLeft = Math.max(8, viewportWidth - MENU_WIDTH - 16);
            const clampedLeft = Math.min(Math.max(8, rect.left), maxLeft);
            const baseTop = rect.bottom + offset;
            const bottomTop = Math.min(Math.max(8, baseTop), Math.max(8, viewportHeight - heightForPlacement - 8));
            const topTop = Math.max(8, rect.top - heightForPlacement - offset);
            const finalTop = placement === 'top' ? topTop : bottomTop;
            setPosition({
                top: finalTop,
                left: clampedLeft,
                placement,
            });
        };
        updatePosition();
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);
        return () => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        };
    }, [anchorRef, isOpen, menuHeight, offset]);
    return position;
}
function useMenuHeight<T extends HTMLElement>() {
    const menuRef = useRef<T | null>(null);
    const [height, setHeight] = useState(0);
    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!el || typeof window === 'undefined') {
            return;
        }
        const updateHeight = () => {
            if (!menuRef.current)
                return;
            setHeight(menuRef.current.offsetHeight);
        };
        updateHeight();
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => updateHeight());
            observer.observe(el);
            return () => observer.disconnect();
        }
        window.addEventListener('resize', updateHeight);
        return () => {
            window.removeEventListener('resize', updateHeight);
        };
    }, []);
    return { menuRef, height };
}
interface TemplatesMenuProps {
    anchorRef: RefObject<HTMLButtonElement | null>;
    loading: boolean;
    onSelect: (templateId: string) => void;
}
function TemplatesMenu({ anchorRef, loading, onSelect }: TemplatesMenuProps) {
    const { menuRef, height } = useMenuHeight<HTMLDivElement>();
    const position = useAnchorPosition(anchorRef, true, height);
    if (typeof document === 'undefined' || !anchorRef.current) {
        return null;
    }
    const portalStyle: CSSProperties = position
        ? { top: position.top, left: position.left }
        : { visibility: 'hidden', pointerEvents: 'none', top: 0, left: 0 };
    return createPortal(<div ref={menuRef} className="fixed z-[9999] w-72 rounded-2xl border border-gray-800 bg-gray-950/95 p-3 shadow-2xl shadow-black/40 backdrop-blur" data-placement={position?.placement ?? 'bottom'} style={portalStyle}>
      <p className="text-xs uppercase tracking-wide text-gray-400">Choose a template</p>
      <div className="mt-2 max-h-60 space-y-2 overflow-y-auto pr-1">
        {templates.map((template) => {
            const TemplateIcon = template.icon;
            return (<button key={template.id} type="button" onClick={() => onSelect(template.id)} disabled={loading} className="group flex w-full items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/80 px-3 py-2 text-left text-sm text-gray-200 transition hover:-translate-y-0.5 hover:border-blue-500/50 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300 transition group-hover:bg-blue-500/20 group-hover:text-blue-200">
                <TemplateIcon className="h-5 w-5"/>
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold text-gray-100">{template.name}</span>
                <span className="block text-xs text-gray-400">{template.description}</span>
              </span>
            </button>);
        })}
      </div>
    </div>, document.body);
}
interface CourseContextMenuProps {
    anchorRef: RefObject<HTMLButtonElement | null>;
    loading: boolean;
    courseCtx: string;
    onCourseCtxChange: (value: string) => void;
}
function CourseContextMenu({ anchorRef, loading, courseCtx, onCourseCtxChange, }: CourseContextMenuProps) {
    const { menuRef, height } = useMenuHeight<HTMLDivElement>();
    const position = useAnchorPosition(anchorRef, true, height);
    if (typeof document === 'undefined' || !anchorRef.current) {
        return null;
    }
    const portalStyle: CSSProperties = position
        ? { top: position.top, left: position.left }
        : { visibility: 'hidden', pointerEvents: 'none', top: 0, left: 0 };
    return createPortal(<div ref={menuRef} className="fixed z-[9999] w-72 rounded-2xl border border-gray-800 bg-gray-950/95 p-3 shadow-2xl shadow-black/40 backdrop-blur" data-placement={position?.placement ?? 'bottom'} style={portalStyle}>
      <label className="text-xs uppercase tracking-wide text-gray-400">Course context</label>
      <textarea value={courseCtx} onChange={(e) => onCourseCtxChange(e.target.value)} placeholder="Paste rubric or course guidelines..." className="mt-2 h-28 w-full resize-none rounded-xl border border-gray-800 bg-gray-900/70 p-3 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/30" disabled={loading}/>
    </div>, document.body);
}
