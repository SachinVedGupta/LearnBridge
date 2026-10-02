'use client';

import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import Highlight from '@tiptap/extension-highlight';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { useEffect } from 'react';
import type { Editor as EditorType } from '@tiptap/react';
import { InlineSuggestions } from '@/extensions/InlineSuggestions';
import { 
  ArrowUturnLeftIcon, 
  ArrowUturnRightIcon,
  ListBulletIcon,
  NumberedListIcon,
  Bars3Icon,
  Bars3CenterLeftIcon,
  BarsArrowDownIcon
} from '@heroicons/react/24/outline';

interface EditorProps {
  onEditorReady?: (editor: any) => void;
}

export default function Editor({ onEditorReady }: EditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      InlineSuggestions,
    ],
    content: '<p>Start writing your assignment here...</p>',
    editorProps: {
      attributes: {
        class:
          'tiptap min-h-[60vh] text-gray-100 leading-relaxed selection:bg-indigo-500/30 focus:outline-none',
      },
    },
  });

  // Use editorState hook for reactive toolbar state
  const editorState = useEditorState({
    editor,
    selector: (ctx) => ({
      isBold: ctx.editor?.isActive('bold') ?? false,
      canBold: ctx.editor?.can().chain().toggleBold().run() ?? false,
      isItalic: ctx.editor?.isActive('italic') ?? false,
      canItalic: ctx.editor?.can().chain().toggleItalic().run() ?? false,
      isStrike: ctx.editor?.isActive('strike') ?? false,
      canStrike: ctx.editor?.can().chain().toggleStrike().run() ?? false,
      isHeading1: ctx.editor?.isActive('heading', { level: 1 }) ?? false,
      isHeading2: ctx.editor?.isActive('heading', { level: 2 }) ?? false,
      isHeading3: ctx.editor?.isActive('heading', { level: 3 }) ?? false,
      isParagraph: ctx.editor?.isActive('paragraph') ?? false,
      isBulletList: ctx.editor?.isActive('bulletList') ?? false,
      isOrderedList: ctx.editor?.isActive('orderedList') ?? false,
      isAlignLeft: ctx.editor?.isActive({ textAlign: 'left' }) ?? false,
      isAlignCenter: ctx.editor?.isActive({ textAlign: 'center' }) ?? false,
      isAlignRight: ctx.editor?.isActive({ textAlign: 'right' }) ?? false,
      isAlignJustify: ctx.editor?.isActive({ textAlign: 'justify' }) ?? false,
      canUndo: ctx.editor?.can().chain().undo().run() ?? false,
      canRedo: ctx.editor?.can().chain().redo().run() ?? false,
    }),
  });

  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  if (!editor) {
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-gray-800/70 bg-gradient-to-br from-gray-950/95 via-gray-900/90 to-gray-950/95 shadow-[0_18px_45px_rgba(10,14,32,0.65)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-800/70 bg-gray-900/85 px-3 py-2">
        {/* Undo/Redo */}
        <button
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editorState?.canUndo}
          className="p-2 text-gray-300 hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
          title="Undo"
        >
          <ArrowUturnLeftIcon className="w-5 h-5" />
        </button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editorState?.canRedo}
          className="p-2 text-gray-300 hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
          title="Redo"
        >
          <ArrowUturnRightIcon className="w-5 h-5" />
        </button>

        <div className="w-px h-8 bg-gray-700 mx-1"></div>

        {/* Heading Dropdown */}
        <select
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'p') {
              editor.chain().focus().setParagraph().run();
            } else {
              editor.chain().focus().toggleHeading({ level: parseInt(value) as 1 | 2 | 3 }).run();
            }
          }}
          className="px-3 py-1 text-sm bg-gray-700 text-gray-300 border border-gray-600 rounded hover:bg-gray-600 focus:ring-2 focus:ring-blue-600"
          value={
            editorState?.isHeading1 ? '1' :
            editorState?.isHeading2 ? '2' :
            editorState?.isHeading3 ? '3' :
            'p'
          }
        >
          <option value="p">Paragraph</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
        </select>

        <div className="w-px h-8 bg-gray-700 mx-1"></div>

        {/* Text Formatting */}
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={!editorState?.canBold}
          className={`p-2 rounded font-bold ${
            editorState?.isBold 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Bold"
        >
          B
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={!editorState?.canItalic}
          className={`p-2 rounded italic font-serif ${
            editorState?.isItalic 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Italic"
        >
          I
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          disabled={!editorState?.canStrike}
          className={`p-2 rounded line-through ${
            editorState?.isStrike 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Strikethrough"
        >
          S
        </button>

        <div className="w-px h-8 bg-gray-700 mx-1"></div>

        {/* Lists */}
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`p-2 rounded ${
            editorState?.isBulletList 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Bullet List"
        >
          <ListBulletIcon className="w-5 h-5" />
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`p-2 rounded ${
            editorState?.isOrderedList 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Numbered List"
        >
          <NumberedListIcon className="w-5 h-5" />
        </button>

        <div className="w-px h-8 bg-gray-700 mx-1"></div>

        {/* Text Alignment */}

        <button
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          className={`p-2 rounded ${
            editorState?.isAlignLeft 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Align Left"
        >
          <Bars3CenterLeftIcon className="w-5 h-5" />
        </button> 
        <button
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          className={`p-2 rounded ${
            editorState?.isAlignCenter 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Align Center"
        >
          <Bars3Icon className="w-5 h-5" />
        </button>

        <button
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          className={`p-2 rounded ${
            editorState?.isAlignRight 
              ? 'bg-blue-600 text-white' 
              : 'text-gray-300 hover:bg-gray-700'
          }`}
          title="Align Right"
        >
          <Bars3CenterLeftIcon className="w-5 h-5 -scale-x-100" />
        </button>
      </div>

      {/* Editor Content */}
      <div className="flex-1 overflow-y-auto bg-gray-950/60 px-4 pb-6 pt-4 md:px-6 md:pb-10 md:pt-6">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
