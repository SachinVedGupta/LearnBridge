# Assignment AI 🎓

AI-powered assignment editor with tutoring and editing modes, built with Next.js + TipTap and Gemini API.

## 📐 Architecture

This is a monorepo using **npm workspaces** with three packages:

```
assignment-ai/
├── apps/
│   ├── web/          # Next.js frontend (port 3000)
│   └── api/          # Express backend (port 4000)
└── packages/
    └── shared/       # TypeScript contracts & prompts
```

### Tech Stack

**Frontend:**
- Next.js 14 (App Router)
- TipTap editor with StarterKit
- React 18
- Tailwind CSS
- TypeScript

**Backend:**
- Express.js
- Google Gemini AI (1.5 Flash & Pro)
- Zod validation
- TypeScript

**Shared:**
- TypeScript contracts (types + schemas)
- System prompts for AI modes

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20+
- npm (comes with Node.js)
- Gemini API key ([Get one here](https://ai.google.dev/))

### 2. Installation

```bash
# Install all dependencies
npm install
```

### 3. Environment Setup

Create a `.env` file in the root directory:

```bash
# Backend - Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# Frontend - API Base URL
NEXT_PUBLIC_API_BASE=/api
```

### 4. Run Development Servers

**Terminal 1 - Backend:**
```bash
npm run dev:api
```

**Terminal 2 - Frontend:**
```bash
npm run dev:web
```

**Or run both separately:**
```bash
cd apps/api && npm run dev     # Backend on port 4000
cd apps/web && npm run dev     # Frontend on port 3000
```

### 5. Access the App

Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🎯 Features

### Ask Mode (Tutoring)

- **What:** Get guidance and hints on your assignment
- **How:** Click "Ask: Get Guidance" button
- **Uses:** Gemini 1.5 Flash for fast responses
- **Output:** Tutoring guidance displayed in sidebar
- **Behavior:** Never gives full solutions, only hints and structure advice

### Agent Mode (Inline Suggestions)

- **What:** Cursor-like inline editing suggestions
- **How:** Select text → Enter instructions → Review red-highlighted suggestions
- **Uses:** Gemini 1.5 Pro for structured micro-edits
- **Output:** Inline suggestions with accept/reject controls
- **Behavior:** Proposes minimal word/phrase replacements for clarity, grammar, and academic style

#### Inline Suggestions - Range Mapping

Suggestions use **relative ranges** (0-based, exclusive end) within the selected text:

- Server receives `docSlice` (selected text) and returns suggestions with `range: {from, to}` relative to it
- Client maps to absolute positions: `absFrom = selectionStart + from`, `absTo = selectionStart + to`
- Before applying, verify `original` still matches live document text (stale detection)

**Example:**
- Selection: "The studys are good" at position 100-118
- Suggestion: `{range: {from: 4, to: 10}, original: "studys", replacement: "studies"}`
- Mapped: `{absoluteFrom: 104, absoluteTo: 110}`

**Features:**
- Red highlights show original text to be changed
- Green text in sidebar shows replacement
- Stale detection prevents conflicts from concurrent edits
- Confidence scores and severity labels (grammar/clarity/style/citation)
- Accept/Reject individual suggestions or all at once

### Course Context (RAG Stub)

- Optional textarea for pasting rubric/guidelines
- Passed to AI in both modes
- Future: Will integrate with pgvector for semantic retrieval

## 🏗️ Project Structure

### `/apps/web` - Frontend

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx       # Root layout
│   │   ├── page.tsx         # Main page (grid layout)
│   │   └── globals.css      # Tailwind + custom styles
│   ├── components/
│   │   ├── Editor.tsx       # TipTap editor wrapper
│   │   ├── Toolbar.tsx      # Action buttons + course context
│   │   └── Sidebar.tsx      # AI response display
│   └── lib/
│       └── api.ts           # API client (fetch wrappers)
├── next.config.js           # API proxy to backend
└── tailwind.config.js       # Tailwind configuration
```

### `/apps/api` - Backend

```
apps/api/
├── src/
│   ├── index.ts             # Express app setup
│   ├── routes/
│   │   ├── ask.ts           # POST /ask - tutoring mode
│   │   ├── edit.ts          # POST /edit - agent mode
│   │   └── health.ts        # GET /healthz - health check
│   └── services/
│       └── gemini.ts        # Gemini API client
└── tsconfig.json
```

### `/packages/shared` - Shared Types

```
packages/shared/
└── src/
    ├── contracts.ts         # Zod schemas + TypeScript types
    ├── prompts.ts           # System prompts for AI
    └── index.ts             # Barrel exports
```

## 🔌 API Endpoints

### `POST /ask`

**Request:**
```json
{
  "docSlice": "string",
  "instructions": "string",
  "courseCtx": "string (optional)"
}
```

**Response:**
```json
{
  "assistant_text": "string"
}
```

### `POST /edit`

**Request:**
```json
{
  "docSlice": "string",
  "range": {"from": 0, "to": 100},
  "instructions": "string",
  "courseCtx": "string (optional)"
}
```

**Response:**
```json
{
  "suggestions": [
    {
      "id": "uuid",
      "type": "replace",
      "range": {"from": 4, "to": 10},
      "original": "studys",
      "replacement": "studies",
      "reason": "Plural form",
      "confidence": 0.95,
      "severity": "grammar"
    }
  ],
  "summary": "Fixed 1 grammar issue"
}
```

**Notes:**
- Ranges are **relative** to `docSlice` (0-based, exclusive end)
- Server validates each suggestion with Zod, drops invalid ones
- Deduplicates by `(range, replacement)`
- Caps at 10 suggestions maximum
- Extracts `original` text from `docSlice` automatically

### `GET /healthz`

**Response:**
```json
{
  "status": "ok"
}
```

## 🧪 Testing Checklist

- [ ] **Zero-length selection:** Agent mode shows error, doesn't crash
- [ ] **Non-JSON response:** Backend fallback wraps raw output as replace op
- [ ] **Undo/redo:** Works after Agent edits are applied
- [ ] **Console logs:** Show request type and latency
- [ ] **Ask mode:** Response appears in sidebar
- [ ] **Agent mode:** Edits applied to selection correctly
- [ ] **Course context:** Passed to backend when provided
- [ ] **Startup:** Both servers start without errors

## 🛠️ Development Commands

```bash
# Root commands
npm run dev:api          # Start backend
npm run dev:web          # Start frontend
npm run build            # Build all packages

# Package-specific
npm -w @assignment-ai/shared run build
npm -w @assignment-ai/api run dev
npm -w @assignment-ai/web run dev
```

## 🔮 Future Enhancements

### RAG Implementation (Not Yet Implemented)

- Gemini embeddings for course materials
- pgvector for semantic search
- Automatic context retrieval based on assignment content
- Replace manual "Course Context" textarea with smart retrieval

### Additional Features

- User authentication
- Assignment history/versioning
- Export to PDF/Word
- Collaborative editing
- Custom AI instructions per assignment

## 📝 Notes

- **Local only:** No hosting setup, runs on localhost
- **No auth:** All data in memory, no persistence
- **API proxy:** Next.js dev server proxies `/api/*` → `http://localhost:4000`
- **Minimal styling:** Basic Tailwind for functionality focus
- **Error handling:** Graceful fallbacks for API failures and invalid selections

## 🐛 Troubleshooting

**Backend won't start:**
- Check `GEMINI_API_KEY` is set in `.env`
- Verify port 4000 is available
- Run `npm install` in root

**Frontend can't reach API:**
- Ensure backend is running on port 4000
- Check Next.js rewrites in `next.config.js`
- Verify `NEXT_PUBLIC_API_BASE=/api` in `.env`

**Editor not loading:**
- Clear `.next` cache: `rm -rf apps/web/.next`
- Reinstall: `npm install`
- Check browser console for errors

**TypeScript errors:**
- Run `npm run build` in root to compile shared package first
- Check `tsconfig.json` extends are correct
- Restart TypeScript server in IDE

## 📄 License

MIT

