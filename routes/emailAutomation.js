import express from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { startAutomation, stopAutomation, getStatus } from '../services/emailAutomationService.js';
import { scoreContacts } from '../services/emailValidationService.js';

const router = express.Router();

router.use(authMiddleware);

// POST /api/email-automation/validate
router.post('/validate', async (req, res) => {
  try {
    const { contactIds } = req.body; // opsiyonel — boşsa tüm pending kontaklar
    const result = await scoreContacts(contactIds || []);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Validation error:', err);
    res.status(500).json({ success: false, error: err.message || 'Validation failed' });
  }
});

// POST /api/email-automation/start
router.post('/start', async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'Konu ve içerik zorunlu.' });
    }
    const result = await startAutomation(subject, body);
    res.json(result);
  } catch (err) {
    console.error('Automation start error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/email-automation/stop
router.post('/stop', (req, res) => {
  stopAutomation();
  res.json({ success: true, message: 'Durduruldu.' });
});

// GET /api/email-automation/status
router.get('/status', (req, res) => {
  res.json(getStatus());
});

export default router;
