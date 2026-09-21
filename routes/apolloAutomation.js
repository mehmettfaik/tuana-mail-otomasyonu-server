import express from 'express';
import { 
  startApolloAutomation, 
  stopApolloAutomation, 
  getApolloStatus 
} from '../services/apolloAutomationService.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Durumu al
router.get('/status', authenticateToken, (req, res) => {
  res.json(getApolloStatus());
});

// Otomasyonu başlat
router.post('/start', authenticateToken, async (req, res) => {
  const { sequenceId, targetTitles } = req.body;
  
  // Varsayılan pozisyonlar
  const titles = targetTitles && targetTitles.length > 0 
    ? targetTitles 
    : ['CEO', 'Founder', 'Owner', 'Managing Director', 'Marketing'];

  const result = await startApolloAutomation(sequenceId, titles);
  if (result.success) {
    res.json({ message: result.message });
  } else {
    res.status(400).json({ error: result.message });
  }
});

// Otomasyonu durdur
router.post('/stop', authenticateToken, (req, res) => {
  stopApolloAutomation();
  res.json({ message: 'Otomasyon durduruldu.' });
});

export default router;
