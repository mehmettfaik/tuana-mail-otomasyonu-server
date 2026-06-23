import express from 'express';
import { supabase } from '../supabaseClient.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

// GET /api/contacts/check-company (MUST BE BEFORE /:id)
router.get('/check-company', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.json({ exists: false, matches: [] });

    const { data, error } = await supabase
      .from('contacts')
      .select('company_name')
      .ilike('company_name', `%${name}%`);

    if (error) throw error;

    const matches = [...new Set(data.map(c => c.company_name).filter(Boolean))];
    return res.json({ exists: matches.length > 0, matches });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/contacts/bulk (MUST BE BEFORE /:id)
router.post('/bulk', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ success: false, error: 'Invalid data' });
    }

    // Fetch existing contacts to check for duplicates
    // We pull first_name, last_name, company_name and existing_email for matching
    const { data: existingContacts, error: fetchError } = await supabase
      .from('contacts')
      .select('first_name, last_name, company_name, existing_email');

    if (fetchError) throw fetchError;

    // Build a Set of normalized keys for fast lookup
    const existingKeys = new Set();
    (existingContacts || []).forEach(ec => {
      // Key 1: first_name + last_name + company_name (case-insensitive, trimmed)
      const nameKey = [
        (ec.first_name || '').toLowerCase().trim(),
        (ec.last_name || '').toLowerCase().trim(),
        (ec.company_name || '').toLowerCase().trim()
      ].join('|');
      existingKeys.add(nameKey);

      // Key 2: existing_email (if present)
      if (ec.existing_email && ec.existing_email.trim()) {
        existingKeys.add('email:' + ec.existing_email.toLowerCase().trim());
      }
    });

    const duplicates = [];
    const newContacts = [];

    contacts.forEach(c => {
      const nameKey = [
        (c.first_name || '').toLowerCase().trim(),
        (c.last_name || '').toLowerCase().trim(),
        (c.company_name || '').toLowerCase().trim()
      ].join('|');

      const emailKey = c.existing_email && c.existing_email.trim()
        ? 'email:' + c.existing_email.toLowerCase().trim()
        : null;

      const isDuplicate = existingKeys.has(nameKey) || (emailKey && existingKeys.has(emailKey));

      if (isDuplicate) {
        duplicates.push({
          first_name: c.first_name,
          last_name: c.last_name,
          company_name: c.company_name,
          existing_email: c.existing_email
        });
      } else {
        newContacts.push(c);
        // Add this contact's keys to the set so intra-batch duplicates are also caught
        existingKeys.add(nameKey);
        if (emailKey) existingKeys.add(emailKey);
      }
    });

    let insertedCount = 0;

    if (newContacts.length > 0) {
      const payload = newContacts.map(c => {
        const contactObj = {
          first_name: c.first_name,
          last_name: c.last_name,
          company_name: c.company_name,
          country: c.country,
          website: c.website,
          position: c.position,
          existing_email: c.existing_email,
          email_sent: false,
          email_opened: false,
          replied: false
        };

        // Add guessed emails if provided
        if (c.guessedEmails && Array.isArray(c.guessedEmails)) {
          c.guessedEmails.forEach((email, i) => {
            if (i < 18) {
              contactObj[`guessed_email_${i + 1}`] = email;
            }
          });
        }

        return contactObj;
      });

      const { error } = await supabase
        .from('contacts')
        .insert(payload);

      if (error) throw error;
      insertedCount = payload.length;
    }

    return res.json({
      success: true,
      count: insertedCount,
      duplicateCount: duplicates.length,
      duplicates: duplicates.slice(0, 20) // Return first 20 duplicates for display
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/contacts/stats (MUST BE BEFORE /:id)
router.get('/stats', async (req, res) => {
  try {
    const { count: total } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });

    const { count: sent } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('email_sent', true);

    const { count: opened } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('email_opened', true);

    return res.json({ total: total || 0, sent: sent || 0, opened: opened || 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' });

    if (req.query.search) {
      const s = req.query.search;
      query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company_name.ilike.%${s}%,existing_email.ilike.%${s}%`);
    }

    if (req.query.status === 'sent') {
      query = query.eq('email_sent', true);
    } else if (req.query.status === 'pending') {
      query = query.eq('email_sent', false);
    } else if (req.query.status === 'opened') {
      query = query.eq('email_opened', true);
    }

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, count, error } = await query;

    if (error) throw error;

    return res.json({ data, total: count, page, limit });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  try {
    const { 
      first_name, 
      last_name, 
      company_name, 
      country, 
      website, 
      position, 
      existing_email,
      guessedEmails = [] 
    } = req.body;

    const payload = {
      first_name,
      last_name,
      company_name,
      country,
      website,
      position,
      existing_email,
      email_sent: false,
      email_opened: false,
      replied: false
    };

    // Add guessed emails to payload
    for (let i = 0; i < guessedEmails.length; i++) {
      if (i < 18) {
        payload[`guessed_email_${i + 1}`] = guessedEmails[i];
      }
    }

    const { data, error } = await supabase
      .from('contacts')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
