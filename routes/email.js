import express from 'express';
import nodemailer from 'nodemailer';
import { supabase } from '../supabaseClient.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/send', async (req, res) => {
  try {
    const { contact_id, subject, body, emails } = req.body;

    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    let targetEmails = emails;
    if (!targetEmails || targetEmails.length === 0) {
      const fallback = contact.existing_email || contact.selected_email || contact.guessed_email_1;
      if (!fallback) {
        return res.status(400).json({ success: false, error: 'No email found for this contact' });
      }
      targetEmails = [fallback];
    }

    const trackingPixel = `<img src="${process.env.TRACKING_BASE_URL}/api/track/${contact_id}" width="1" height="1" style="display:none" />`;
    const finalHtml = `<div style="white-space: pre-wrap; font-family: inherit;">${body}</div>` + trackingPixel;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    for (const email of targetEmails) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: subject,
        html: finalHtml,
      });
    }

    const { error: updateError } = await supabase
      .from('contacts')
      .update({ email_sent: true, sent_at: new Date().toISOString() })
      .eq('id', contact_id);

    if (updateError) {
      console.error('Update contact status error:', updateError);
    }

    const { error: logError } = await supabase
      .from('email_logs')
      .insert([{
        contact_id,
        subject,
        body: finalHtml,
        sent_at: new Date().toISOString()
      }]);

    if (logError) {
      console.error('Email log insert error:', logError);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
