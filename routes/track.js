import express from 'express';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

router.get('/:contact_id', async (req, res) => {
  try {
    const { contact_id } = req.params;

    const { error } = await supabase
      .from('contacts')
      .update({ email_opened: true, opened_at: new Date().toISOString() })
      .eq('id', contact_id);

    if (error) {
      console.error('Tracking update error:', error);
    }
  } catch (err) {
    console.error('Tracking error:', err);
  } finally {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    
    const GIF = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64'
    );
    res.end(GIF);
  }
});

export default router;
