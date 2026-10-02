import { config } from 'dotenv';
import { resolve } from 'path';
import express from 'express';
import cors from 'cors';
import askRouter from './routes/ask';
import editRouter from './routes/edit';
import healthRouter from './routes/health';

// Load .env from root directory (two levels up from src/)
config({ path: resolve(__dirname, '../../../.env') });

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Routes
app.use('/', healthRouter);
app.use('/', askRouter);
app.use('/', editRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
});

