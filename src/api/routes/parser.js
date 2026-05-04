/**
 * Parser routes.
 *
 * POST /api/parse   { source: string } → ParsedScript (blocks JSON)
 */

import { Router } from 'express';
import { parse } from '../../parser/index.js';

export const router = Router();

router.post('/', (req, res) => {
  try {
    const { source } = req.body;
    if (typeof source !== 'string' || !source.trim()) {
      return res.status(400).json({ success: false, error: 'source string required' });
    }

    const parsed = parse(source);
    res.json({ success: true, parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
