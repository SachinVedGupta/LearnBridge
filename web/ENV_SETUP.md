# Environment Setup

Create a `.env` file in the root directory with these variables:

```bash
# Backend - Gemini API Key
# Get your API key from: https://ai.google.dev/
GEMINI_API_KEY=your_gemini_api_key_here

# Frontend - API Base URL
NEXT_PUBLIC_API_BASE=/api
```

## Getting a Gemini API Key

1. Visit [Google AI Studio](https://ai.google.dev/)
2. Sign in with your Google account
3. Click "Get API Key"
4. Create a new API key or use an existing one
5. Copy the key and paste it in your `.env` file

## Notes

- The `.env` file is gitignored and will not be committed
- Both backend and frontend read from the same `.env` file
- Make sure to restart both servers after changing environment variables

