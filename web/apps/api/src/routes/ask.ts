import { Router } from 'express';
import { AskInSchema, AskOut, ASK_SYSTEM } from '@assignment-ai/shared';
import { callFlash } from '../services/gemini';

const router = Router();

router.post('/ask', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Validate input
    const parseResult = AskInSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        details: parseResult.error.issues 
      });
    }

    const { docSlice, instructions, courseCtx } = parseResult.data;

    // Build prompt
    let prompt = ASK_SYSTEM + '\n\n';
    
    if (courseCtx) {
      prompt += `Course Context:\n${courseCtx}\n\n`;
    }
    
    prompt += `Student Instructions:\n${instructions}\n\n`;
    prompt += `Document Content:\n${docSlice}\n\n`;
    prompt += `Provide guidance based on the above.`;

    // Call Gemini Flash
    const assistantText = await callFlash(prompt);

    const duration = Date.now() - startTime;
    console.log(`[ASK] Completed in ${duration}ms`);

    const response: AskOut = {
      assistant_text: assistantText,
    };

    res.json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ASK] Failed after ${duration}ms:`, error);
    
    res.status(502).json({ 
      error: 'LLM service error', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;

