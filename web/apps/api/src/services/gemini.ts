import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

// Gemini 2.5 Flash for Ask mode (free tier: 10 RPM, 250K TPM)
export async function callFlash(prompt: string): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}

// JSON schema for structured output (EditOut)
const EDIT_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    suggestions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          replacement: {
            type: SchemaType.STRING,
            description: 'The suggested replacement text'
          },
          reason: {
            type: SchemaType.STRING,
            description: 'Brief explanation for the suggestion'
          },
          from: {
            type: SchemaType.INTEGER,
            description: 'Start position in the selected text (0-indexed)'
          },
          to: {
            type: SchemaType.INTEGER,
            description: 'End position in the selected text (0-indexed)'
          }
        },
        required: ['replacement', 'reason', 'from', 'to'],
        propertyOrdering: ['from', 'to', 'replacement', 'reason']
      }
    },
    summary: {
      type: SchemaType.STRING,
      description: 'One sentence summary of what was changed/added (e.g. "Added 5 materials to the materials section")'
    }
  },
  required: ['suggestions', 'summary'],
  propertyOrdering: ['suggestions', 'summary']
};

// Gemini 2.5 Flash for Agent mode with structured output
export async function callProStructured(prompt: string): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ 
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: EDIT_RESPONSE_SCHEMA
    }
  });
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}

// Fallback: Gemini 2.5 Flash for Agent mode (unstructured, for backward compatibility)
export async function callPro(prompt: string): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ 
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.7,
    }
  });
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}

