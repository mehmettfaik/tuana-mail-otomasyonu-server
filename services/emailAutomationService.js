import nodemailer from 'nodemailer';
import { supabase } from '../supabaseClient.js';

// ── In-memory state ──
const state = {
  isRunning: false,
  isPaused: false,
  pausedUntil: null,
  pauseReason: null,
  consecutiveSpamHours: 0,
  lastSpamAt: null,
  totalSent: 0,
  totalFailed: 0,
  totalTarget: 0,
  dailySendCount: 0,
  dailyResetDate: new Date().toDateString(),
  dashboardMessage: 'Henüz başlatılmadı.',
  errors: [],        // Son hataları tutar (max 50)
  currentContact: null,
};

const DAILY_LIMIT = 450;
const DELAY_BETWEEN_EMAILS_MS = 30_000; // 30 saniye

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetDailyCountIfNeeded() {
  const today = new Date().toDateString();
  if (state.dailyResetDate !== today) {
    state.dailySendCount = 0;
    state.dailyResetDate = today;
  }
}

function addError(msg) {
  state.errors.unshift({ message: msg, time: new Date().toISOString() });
  if (state.errors.length > 50) state.errors.length = 50;
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function personalizeContent(template, firstName) {
  return template.replace(/\{\{first_name\}\}/gi, firstName || '');
}

// ── E-posta normalize (lowercase + trim) ──
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// ── Kontağın sent_emails alanını parse et → Set döndür (normalize edilmiş) ──
function parseSentEmails(sentEmailsStr) {
  if (!sentEmailsStr) return new Set();
  return new Set(
    sentEmailsStr.split(',')
      .map(e => normalizeEmail(e))
      .filter(Boolean)
  );
}

// ── Kontağın tüm e-posta adreslerini topla (normalize edilmiş, unique) ──
function getContactEmails(contact) {
  const seen = new Set();
  const emails = [];

  const candidates = [];
  if (contact.existing_email) candidates.push(contact.existing_email);
  if (contact.selected_email) candidates.push(contact.selected_email);
  for (let i = 1; i <= 18; i++) {
    const e = contact[`guessed_email_${i}`];
    if (e) candidates.push(e);
  }

  for (const raw of candidates) {
    const normalized = normalizeEmail(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      emails.push(normalized);
    }
  }

  return emails;
}

// ── DB'den kontağın güncel sent_emails verisini oku ──
async function fetchSentEmailsFromDB(contactId) {
  try {
    // select('*') kullanıyoruz çünkü select('sent_emails') PostgREST
    // şema önbelleğinde sütunu bulamazsa hata verir
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (error) {
      console.error(`[Automation] DB read error for contact ${contactId}:`, error.message);
      return null; // null = DB okunamadı
    }
    return parseSentEmails(data.sent_emails);
  } catch (err) {
    console.error(`[Automation] Unexpected error reading contact ${contactId}:`, err.message);
    return null;
  }
}

// ── sent_emails'i DB'ye yaz (retry ile) ──
async function updateSentEmailsInDB(contactId, sentEmailsSet, allEmailsDone) {
  const sentEmailsStr = [...sentEmailsSet].join(',');
  const updatePayload = {
    sent_emails: sentEmailsStr,
    sent_at: new Date().toISOString()
  };
  if (allEmailsDone) {
    updatePayload.email_sent = true;
  }

  // İlk deneme — sent_emails dahil tam güncelleme
  const { error } = await supabase
    .from('contacts')
    .update(updatePayload)
    .eq('id', contactId);

  if (!error) {
    console.log(`[Automation] ✓ DB updated: contact ${contactId} → sent_emails="${sentEmailsStr}", email_sent=${allEmailsDone}`);
    return true;
  }

  console.error(`[Automation] DB update FAILED (attempt 1) for contact ${contactId}:`, error.message);

  // İkinci deneme
  await sleep(1000);
  const { error: retryError } = await supabase
    .from('contacts')
    .update(updatePayload)
    .eq('id', contactId);

  if (!retryError) {
    console.log(`[Automation] ✓ DB updated on retry: contact ${contactId}`);
    return true;
  }

  console.error(`[Automation] DB update FAILED (attempt 2) for contact ${contactId}:`, retryError.message);

  // ── Fallback: sent_emails sütunu şema önbelleğinde yoksa ──
  // En azından email_sent ve sent_at'ı güncelle ki kontak tekrar işlenmesin
  if (error.message.includes('schema cache') || retryError.message.includes('schema cache')) {
    console.warn(`[Automation] Schema cache issue detected — trying fallback update without sent_emails`);
    const fallbackPayload = { sent_at: new Date().toISOString() };
    if (allEmailsDone) fallbackPayload.email_sent = true;

    const { error: fbError } = await supabase
      .from('contacts')
      .update(fallbackPayload)
      .eq('id', contactId);

    if (!fbError) {
      console.log(`[Automation] ✓ Fallback update OK (without sent_emails): contact ${contactId}, email_sent=${allEmailsDone}`);
      addError(`⚠️ sent_emails sütunu güncellenemedi (schema cache hatası). Supabase SQL Editor'da NOTIFY pgrst, 'reload schema'; çalıştırın.`);
      return true;
    }
    console.error(`[Automation] Fallback update also FAILED:`, fbError.message);
  }

  addError(`DB güncelleme hatası (contact ${contactId}): ${retryError.message}`);
  return false;
}

// ── Spam detection ──
function detectSpamError(error) {
  const spamIndicators = [
    'spam', 'blocked', '550', '421', 'blacklist',
    'policy violation', 'rejected', 'rate limit', 'too many'
  ];
  const msg = (error.message || error.code || '').toLowerCase();
  return spamIndicators.some(ind => msg.includes(ind));
}

// ── Handle errors ──
async function handleSendError(error, contactId, email) {
  const isSpam = detectSpamError(error);
  const errorMsg = error.message || 'Unknown error';

  if (isSpam) {
    const now = new Date();

    if (!state.lastSpamAt) {
      // İlk spam → 20-25 dk bekle
      state.lastSpamAt = now;
      const waitMin = 20 + Math.floor(Math.random() * 6);
      state.pausedUntil = new Date(now.getTime() + waitMin * 60_000);
      state.isPaused = true;
      state.pauseReason = 'spam_20min';
      state.dashboardMessage = ` Spam filtresine takıldı. ${waitMin} dk bekleniyor...`;
      addError(`Spam: ${email} — ${waitMin}dk bekleme`);
    } else {
      const hoursSince = (now.getTime() - state.lastSpamAt.getTime()) / 3_600_000;
      state.consecutiveSpamHours += hoursSince;
      state.lastSpamAt = now;

      if (state.consecutiveSpamHours >= 2) {
        state.isRunning = false;
        state.isPaused = false;
        state.dashboardMessage = '2 saat spam filtresi. İşlem durduruldu.';
        addError('2 saat üst üste spam — otomasyon durduruldu');
        return;
      }

      // 1 saat bekle
      state.pausedUntil = new Date(now.getTime() + 3_600_000);
      state.isPaused = true;
      state.pauseReason = 'spam_1hour';
      state.dashboardMessage = 'Tekrar spam. 1 saat bekleniyor...';
      addError(`Spam tekrar: ${email} — 1 saat bekleme`);
    }
  } else {
    // Normal hata
    state.totalFailed++;
    addError(`Hata (${email}): ${errorMsg}`);
  }
}

// ── Send single email ──
async function sendSingleEmail(contact, emailAddress, subject, body, transporter) {
  try {
    const personalizedSubject = personalizeContent(subject, contact.first_name);
    const personalizedBody = personalizeContent(body, contact.first_name);
    const signature = `<br/><br/><img src="https://drive.google.com/uc?export=view&id=1S5BcNm2sCaFUllzpPYik43fDkhZTIOYA" alt="Tuana Textile" style="max-width:500px;height:auto;" />`;
    const finalHtml = `<div style="white-space: pre-wrap; font-family: inherit;">${personalizedBody}</div>` + signature;

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: emailAddress,
      subject: personalizedSubject,
      html: finalHtml,
    });

    state.totalSent++;
    state.dailySendCount++;
    state.consecutiveSpamHours = 0;
    state.lastSpamAt = null;
    state.dashboardMessage = `✉️ ${contact.first_name} (${emailAddress}) → Gönderildi [${state.totalSent}/${state.totalTarget}]`;
    return true;
  } catch (error) {
    await handleSendError(error, contact.id, emailAddress);
    return false;
  }
}

// ── Main automation ──
export async function startAutomation(subject, body) {
  if (state.isRunning) return { success: false, message: 'Zaten çalışıyor.' };

  // Reset state
  state.isRunning = true;
  state.isPaused = false;
  state.pausedUntil = null;
  state.pauseReason = null;
  state.consecutiveSpamHours = 0;
  state.lastSpamAt = null;
  state.totalSent = 0;
  state.totalFailed = 0;
  state.errors = [];
  state.dashboardMessage = 'Otomasyon başlatılıyor...';

  resetDailyCountIfNeeded();

  const transporter = createTransporter();

  // ── email_sent = false olan kontakları al ──
  let allContacts = [];
  let from = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('email_sent', false)
      .order('created_at', { ascending: true })
      .range(from, from + limit - 1);

    if (error) {
      state.isRunning = false;
      state.dashboardMessage = ' Kontaklar yüklenemedi.';
      addError('DB hatası: ' + error.message);
      return { success: false, message: error.message };
    }

    if (data && data.length > 0) {
      allContacts = allContacts.concat(data);
      from += limit;
      if (data.length < limit) hasMore = false;
    } else {
      hasMore = false;
    }
  }

  if (allContacts.length === 0) {
    state.isRunning = false;
    state.dashboardMessage = 'Gönderilecek kontak bulunamadı.';
    return { success: false, message: 'No pending contacts.' };
  }

  // ── Her kontağın sent_emails sütununa bakarak bekleyen e-posta sayısını hesapla ──
  let totalEmails = 0;
  const contactsWithPending = [];

  for (const c of allContacts) {
    const allEmails = getContactEmails(c);
    const alreadySent = parseSentEmails(c.sent_emails);
    const pending = allEmails.filter(e => !alreadySent.has(e));

    if (pending.length > 0) {
      totalEmails += pending.length;
      contactsWithPending.push(c);
    } else {
      // Bu kontağın tüm e-postalarına zaten gönderilmiş ama email_sent false kalmış
      // → düzelt
      console.log(`[Automation] Contact ${c.first_name} ${c.last_name} has no pending emails, marking email_sent=true`);
      await supabase
        .from('contacts')
        .update({ email_sent: true })
        .eq('id', c.id);
    }
  }

  state.totalTarget = totalEmails;
  state.dashboardMessage = ` ${contactsWithPending.length} kontak, ${totalEmails} email işlenecek...`;

  if (totalEmails === 0) {
    state.isRunning = false;
    state.dashboardMessage = 'Tüm emaillere daha önce gönderilmiş.';
    return { success: false, message: 'Tüm emaillere daha önce gönderilmiş.' };
  }

  console.log(`[Automation] Starting: ${contactsWithPending.length} contacts, ${totalEmails} pending emails`);

  // Background'da çalıştır — sadece pending olanları gönder
  processContacts(contactsWithPending, subject, body, transporter);

  return { success: true, message: 'Başlatıldı.' };
}

// ── Ana işleme döngüsü ──
async function processContacts(contacts, subject, body, transporter) {
  for (const contact of contacts) {
    if (!state.isRunning) break;

    state.currentContact = `${contact.first_name} ${contact.last_name}`;
    const allEmails = getContactEmails(contact);

    // ────────────────────────────────────────────────────────
    // KRİTİK: Her kontağı işlemeye başlamadan önce DB'den
    // GÜNCEL sent_emails verisini oku.
    // Bu sayede otomasyon durdurulup yeniden başlatılsa bile
    // daha önce gönderilmiş e-postalar kesinlikle atlanır.
    // ────────────────────────────────────────────────────────
    const alreadySent = await fetchSentEmailsFromDB(contact.id);

    if (alreadySent === null) {
      // DB okunamadıysa, in-memory veriden fallback
      console.error(`[Automation] Could not read sent_emails from DB for ${contact.id}, using in-memory fallback`);
    }

    // Etkili set: DB'den gelen veya fallback
    const sentSet = alreadySent || parseSentEmails(contact.sent_emails);

    // Bu kontak için gönderilecek adres kalmamışsa atla
    const pendingEmails = allEmails.filter(e => !sentSet.has(e));
    if (pendingEmails.length === 0) {
      console.log(`[Automation] Skipping ${contact.first_name} ${contact.last_name} — all ${allEmails.length} emails already in sent_emails`);
      // email_sent flag'ini de düzelt
      await supabase.from('contacts').update({ email_sent: true }).eq('id', contact.id);
      continue;
    }

    console.log(`[Automation] Processing ${contact.first_name} ${contact.last_name}: ${pendingEmails.length} pending out of ${allEmails.length} total`);

    for (const email of pendingEmails) {
      if (!state.isRunning) break;

      // ────────────────────────────────────────────────────────
      // SON KONTROL: Göndermeden hemen önce tekrar DB'den oku.
      // Bu, aynı e-postanın farklı kontaklarda olma ihtimaline
      // veya race condition'a karşı ekstra güvenlik sağlar.
      // ────────────────────────────────────────────────────────
      const freshSent = await fetchSentEmailsFromDB(contact.id);
      if (freshSent && freshSent.has(email)) {
        console.log(`[Automation] Skipping ${email} — found in DB sent_emails (last-second check)`);
        sentSet.add(email); // local set'i de güncelle
        continue;
      }

      // Günlük limit kontrolü
      resetDailyCountIfNeeded();
      if (state.dailySendCount >= DAILY_LIMIT) {
        state.dashboardMessage = ` Günlük limit (${DAILY_LIMIT}) doldu. Yarın devam edecek.`;
        state.isRunning = false;
        break;
      }

      // Spam bekleme
      if (state.pausedUntil && new Date() < state.pausedUntil) {
        state.dashboardMessage = `Bekleniyor... (${state.pauseReason})`;
        const waitMs = state.pausedUntil.getTime() - Date.now();
        await sleep(waitMs);
        state.isPaused = false;
        state.pausedUntil = null;
        state.pauseReason = null;
        if (!state.isRunning) break;
      }

      // ── Gönder ──
      const sent = await sendSingleEmail(contact, email, subject, body, transporter);

      if (sent) {
        // Başarılı → sent_emails'e ekle ve DB'ye yaz
        sentSet.add(email);

        const remainingEmails = allEmails.filter(e => !sentSet.has(e));
        const allDone = remainingEmails.length === 0;

        const dbOk = await updateSentEmailsInDB(contact.id, sentSet, allDone);
        if (!dbOk) {
          console.error(`[Automation] ⚠️ EMAIL SENT but DB update failed for ${email}! Manual check needed.`);
        }
      }

      // Mailler arası bekleme
      if (state.isRunning) {
        await sleep(DELAY_BETWEEN_EMAILS_MS);
      }
    }
  }

  if (state.isRunning) {
    state.isRunning = false;
    state.dashboardMessage = `Tamamlandı! ${state.totalSent} mail gönderildi.`;
  }
  state.currentContact = null;
}

export function stopAutomation() {
  state.isRunning = false;
  state.isPaused = false;
  state.pausedUntil = null;
  state.pauseReason = null;
  state.totalTarget = 0;
  state.totalSent = 0;
  state.totalFailed = 0;
  state.currentContact = null;
  state.dashboardMessage = 'Kullanıcı tarafından durduruldu.';
}

export function getStatus() {
  return {
    isRunning: state.isRunning,
    isPaused: state.isPaused,
    pausedUntil: state.pausedUntil,
    pauseReason: state.pauseReason,
    totalSent: state.totalSent,
    totalFailed: state.totalFailed,
    totalTarget: state.totalTarget,
    dailySendCount: state.dailySendCount,
    dailyLimit: DAILY_LIMIT,
    message: state.dashboardMessage,
    currentContact: state.currentContact,
    errors: state.errors.slice(0, 20),
  };
}
