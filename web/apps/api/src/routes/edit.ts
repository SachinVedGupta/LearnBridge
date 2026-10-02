import { Router } from 'express';
import { EditInSchema, EditOut, SuggestionSchema, Suggestion, EDIT_SYSTEM } from '@assignment-ai/shared';
import { callProStructured } from '../services/gemini';
import { randomUUID as uuidv4 } from 'node:crypto';

const router = Router();

router.post('/edit', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Validate input
    const parseResult = EditInSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        details: parseResult.error.issues 
      });
    }

    const { docSlice, range, instructions, courseCtx } = parseResult.data;

    // Build prompt
    let prompt = EDIT_SYSTEM + '\n\n';
    
    if (courseCtx) {
      prompt += `Course Context:\n${courseCtx}\n\n`;
    }
    
    // Provide the user's selected text; ranges will be relative to this text
    const selection = docSlice || '';
    prompt += `Selected Text (${selection.length} characters):\n"${selection}"\n\n`;
    prompt += `Student Instructions: ${instructions}\n\n`;
    prompt += `Provide suggestions with character positions (from, to) relative to the Selected Text above.`;

    // Call Gemini Pro with structured output
    const rawResponse = await callProStructured(prompt);

    // Parse structured JSON output
    let editOut: EditOut;
    
    try {
      const parsed = JSON.parse(rawResponse);
      console.log('[EDIT] Structured response:', JSON.stringify(parsed, null, 2));
      
      // Process suggestions from structured output
      let rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      console.log('[EDIT] Suggestions count:', rawSuggestions.length);
      
      const validSuggestions: Suggestion[] = [];
      let droppedCount = 0;

      for (const s of rawSuggestions.slice(0, 20)) { // cap at 20 suggestions
        // Structured output guarantees 'from' and 'to' fields
        const from = s.from;
        const to = s.to;
        
        // Validate range
        if (typeof from !== 'number' || typeof to !== 'number') {
          console.warn('[EDIT] ✗ Invalid range:', s);
          droppedCount++;
          continue;
        }
        
        if (from < 0 || to > selection.length || from > to) {
          console.warn('[EDIT] ✗ Range out of bounds:', { from, to, selectionLength: selection.length });
          droppedCount++;
          continue;
        }
        
        // Build suggestion object
        const suggestion: Suggestion = {
          id: uuidv4(),
          type: 'replace',
          range: { from, to },
          original: selection.substring(from, to),
          replacement: s.replacement || '',
          reason: s.reason || 'Suggested improvement'
        };
        
        // Validate with schema
        const result = SuggestionSchema.safeParse(suggestion);
        if (result.success) {
          validSuggestions.push(result.data);
          console.log(`[EDIT] ✓ Valid suggestion [${from}:${to}]: "${suggestion.original}" → "${suggestion.replacement}"`);
        } else {
          console.warn('[EDIT] ✗ Schema validation failed:', result.error.issues);
          droppedCount++;
        }
      }

      // Deduplicate by (range, replacement)
      const seen = new Set<string>();
      const deduped = validSuggestions.filter(s => {
        const key = `${s.range.from}-${s.range.to}-${s.replacement}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      editOut = {
        suggestions: deduped,
        summary: parsed.summary || `${deduped.length} suggestion${deduped.length !== 1 ? 's' : ''}`,
      };

      console.log(`[EDIT] Returned ${deduped.length} suggestions, dropped ${droppedCount}`);
    } catch (parseError) {
      console.error('[EDIT] Structured output parsing failed:', parseError);
      console.error('[EDIT] Raw response:', rawResponse.substring(0, 500));
      
      // Fallback: single replace suggestion with the entire selection
      const fallbackSuggestion: Suggestion = {
        id: uuidv4(),
        type: 'replace',
        range: { from: 0, to: selection.length },
        original: selection,
        replacement: rawResponse.substring(0, 5000),
        reason: 'Structured output failed - using raw AI response',
      };
      editOut = { 
        suggestions: [fallbackSuggestion], 
        summary: 'Fallback suggestion (structured output failed)' 
      };
    }

    const duration = Date.now() - startTime;
    console.log(`[EDIT] Completed in ${duration}ms with ${editOut.suggestions.length} suggestions`);

    res.json(editOut);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[EDIT] Failed after ${duration}ms:`, error);
    
    res.status(502).json({ 
      error: 'LLM service error', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;

