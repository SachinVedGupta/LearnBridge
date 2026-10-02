import { Router } from 'express';

const router = Router();

router.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

export default router;

