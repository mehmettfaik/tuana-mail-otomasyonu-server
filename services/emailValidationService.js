import dns from 'dns';
import { supabase } from '../supabaseClient.js';

// ── Sabit Listeler ──

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
  'gmx.com', 'gmx.de', 'live.com', 'msn.com', 'me.com',
  'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'outlook.fr', 'outlook.de', 'outlook.co.uk',
  'mail.ru', 'inbox.com', 'fastmail.com', 'tutanota.com',
  'hey.com', 'pm.me', 'proton.me'
]);

const ROLE_BASED_PREFIXES = new Set([
  'info', 'sales', 'admin', 'support', 'contact', 'hello', 'office',
  'help', 'service', 'billing', 'marketing', 'hr', 'press', 'media',
  'webmaster', 'postmaster', 'hostmaster', 'abuse', 'noc', 'security',
  'team', 'staff', 'jobs', 'careers', 'recruitment', 'enquiries',
  'feedback', 'general', 'reception', 'accounts', 'finance',
  'legal', 'compliance', 'procurement', 'purchasing', 'orders',
  'customerservice', 'customer.service', 'customer-service',
  'no-reply', 'noreply', 'do-not-reply', 'donotreply',
  'newsletter', 'subscribe', 'unsubscribe'
]);

// ── Desteklenen Email Patternleri ──
const PATTERNS = [
  { name: '{first}.{last}',  fn: (f, l) => `${f}.${l}` },
  { name: '{first}{last}',   fn: (f, l) => `${f}${l}` },
  { name: '{first}_{last}',  fn: (f, l) => `${f}_${l}` },
  { name: '{first}-{last}',  fn: (f, l) => `${f}-${l}` },
  { name: '{f}.{last}',      fn: (f, l) => `${f[0]}.${l}` },
  { name: '{f}{last}',       fn: (f, l) => `${f[0]}${l}` },
  { name: '{first}.{l}',     fn: (f, l) => `${f}.${l[0]}` },
  { name: '{first}{l}',      fn: (f, l) => `${f}${l[0]}` },
  { name: '{first}',         fn: (f, l) => `${f}` },
  { name: '{last}',          fn: (f, l) => `${l}` },
];

// ── Türkçe Karakter Temizleme ──
function cleanTurkish(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/[àáä]/g, 'a').replace(/[èéë]/g, 'e')
    .replace(/[ìí]/g, 'i').replace(/[òóô]/g, 'o').replace(/[ùú]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/\s+/g, '')
    .trim();
}

// ── Domain Çıkarma ──
function extractDomain(email) {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[1].toLowerCase().trim();
}

function extractDomainFromWebsite(website) {
  if (!website) return '';
  let domain = website.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
  return domain;
}

// ── 1. Syntax Kontrolü (+5) ──
function syntaxCheck(email) {
  if (!email) return 0;
  // RFC 5322 basitleştirilmiş regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email) ? 5 : 0;
}

// ── 2. Domain Kontrolü (+10) ──
async function domainCheck(domain, cache) {
  if (!domain) return 0;
  if (cache.has(`domain:${domain}`)) return cache.get(`domain:${domain}`);

  try {
    await dns.promises.lookup(domain);
    cache.set(`domain:${domain}`, 10);
    return 10;
  } catch (err) {
    cache.set(`domain:${domain}`, 0);
    return 0;
  }
}

// ── 3. MX Kontrolü (+20) ──
async function mxCheck(domain, cache) {
  if (!domain) return { score: 0, records: [] };
  if (cache.has(`mx:${domain}`)) return cache.get(`mx:${domain}`);

  try {
    const records = await dns.promises.resolveMx(domain);
    const result = { score: records && records.length > 0 ? 20 : 0, records: records || [] };
    cache.set(`mx:${domain}`, result);
    return result;
  } catch (err) {
    const result = { score: 0, records: [] };
    cache.set(`mx:${domain}`, result);
    return result;
  }
}

// ── 4. Şirket Domain Eşleşme (+20) ──
function companyDomainMatch(emailDomain, website) {
  if (!emailDomain || !website) return 0;
  const companyDomain = extractDomainFromWebsite(website);
  if (!companyDomain) return 0;
  return emailDomain.toLowerCase() === companyDomain.toLowerCase() ? 20 : 0;
}

// ── 5. Pattern Eşleşme (+25) ──
function detectPattern(knownEmails, companyDomain) {
  // knownEmails: [{ email, firstName, lastName }]
  if (!knownEmails || knownEmails.length === 0 || !companyDomain) {
    return { pattern: null, confidence: 0 };
  }

  // Sadece şirket domain'iyle eşleşen emailleri filtrele
  const relevantEmails = knownEmails.filter(e => {
    const domain = extractDomain(e.email);
    return domain === companyDomain.toLowerCase();
  });

  if (relevantEmails.length === 0) {
    return { pattern: null, confidence: 0 };
  }

  // Her pattern için kaç email eşleşiyor say
  const patternCounts = {};
  for (const p of PATTERNS) {
    patternCounts[p.name] = 0;
  }

  for (const entry of relevantEmails) {
    const localPart = entry.email.split('@')[0].toLowerCase();
    const first = cleanTurkish(entry.firstName);
    const last = cleanTurkish(entry.lastName);

    if (!first || !last) continue;

    for (const p of PATTERNS) {
      try {
        const expected = p.fn(first, last);
        if (localPart === expected) {
          patternCounts[p.name]++;
        }
      } catch { /* skip */ }
    }
  }

  // En çok eşleşen pattern'i bul
  let bestPattern = null;
  let bestCount = 0;
  for (const [name, count] of Object.entries(patternCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestPattern = name;
    }
  }

  if (bestCount === 0) {
    return { pattern: null, confidence: 0 };
  }

  // Confidence hesapla
  // 1 örnek → 0.4, 2 örnek → 0.7, 3+ → 0.85+, 5+ → 0.95
  let confidence;
  if (bestCount === 1) confidence = 0.4;
  else if (bestCount === 2) confidence = 0.7;
  else if (bestCount === 3) confidence = 0.85;
  else if (bestCount === 4) confidence = 0.9;
  else confidence = 0.95;

  return { pattern: bestPattern, confidence };
}

function checkPatternMatch(email, pattern, firstName, lastName, companyDomain) {
  if (!pattern || !email || !firstName || !lastName) return 0;

  const emailDomain = extractDomain(email);
  if (emailDomain !== companyDomain) return 0;

  const localPart = email.split('@')[0].toLowerCase();
  const first = cleanTurkish(firstName);
  const last = cleanTurkish(lastName);

  const patternDef = PATTERNS.find(p => p.name === pattern);
  if (!patternDef) return 0;

  try {
    const expected = patternDef.fn(first, last);
    return localPart === expected ? 25 : 0;
  } catch {
    return 0;
  }
}

// ── 6. Kişisel Adres Kontrolü (+10) ──
function personalAddressCheck(email, firstName, lastName) {
  if (!email || !firstName) return 0;

  const localPart = email.split('@')[0].toLowerCase();
  const first = cleanTurkish(firstName);
  const last = cleanTurkish(lastName);

  // İsim veya soyisim email'de geçiyor mu?
  if (first && first.length > 1 && localPart.includes(first)) return 10;
  if (last && last.length > 1 && localPart.includes(last)) return 10;

  return 0;
}

// ── 7. Free Mail Kontrolü (+5) ──
function freeMailCheck(emailDomain) {
  if (!emailDomain) return 0;
  return FREE_MAIL_DOMAINS.has(emailDomain.toLowerCase()) ? 0 : 5;
}

// ── 8. Role-based Kontrolü (+5) ──
function roleBasedCheck(email) {
  if (!email) return 0;
  const localPart = email.split('@')[0].toLowerCase();
  return ROLE_BASED_PREFIXES.has(localPart) ? 0 : 5;
}

// ── Şirket Çalışanlarının Bilinen Emaillerini Getir ──
async function getCompanyEmails(companyName) {
  if (!companyName) return [];

  try {
    // Aynı şirketteki tüm kontakları al
    const { data, error } = await supabase
      .from('contacts')
      .select('first_name, last_name, existing_email, guessed_email_1, guessed_email_2, guessed_email_3, guessed_email_4, guessed_email_5, guessed_email_6, guessed_email_7, guessed_email_8, guessed_email_9, guessed_email_10, guessed_email_11, guessed_email_12, guessed_email_13, guessed_email_14, guessed_email_15, guessed_email_16, guessed_email_17, guessed_email_18, email_sent')
      .ilike('company_name', companyName);

    if (error || !data) return [];

    const emails = [];

    for (const contact of data) {
      // Öncelikli kaynak: existing_email (doğrulanmış)
      if (contact.existing_email) {
        emails.push({
          email: contact.existing_email.toLowerCase().trim(),
          firstName: contact.first_name,
          lastName: contact.last_name,
          verified: true
        });
      }

      // İkincil kaynak: email_sent=true olan kontakların guessed emailleri
      // (başarıyla gönderilmiş = muhtemelen geçerli)
      if (contact.email_sent) {
        for (let i = 1; i <= 18; i++) {
          const ge = contact[`guessed_email_${i}`];
          if (ge) {
            emails.push({
              email: ge.toLowerCase().trim(),
              firstName: contact.first_name,
              lastName: contact.last_name,
              verified: false
            });
          }
        }
      }
    }

    return emails;
  } catch (err) {
    console.error('[Validation] Error fetching company emails:', err.message);
    return [];
  }
}

// ── Ana Puanlama Fonksiyonu ──
export async function scoreEmails(contact) {
  const dnsCache = new Map();
  const results = {};

  // Kontağın tüm emaillerini topla
  const emailList = [];
  if (contact.existing_email) emailList.push({ key: 'existing_email', email: contact.existing_email });
  if (contact.selected_email) emailList.push({ key: 'selected_email', email: contact.selected_email });
  for (let i = 1; i <= 18; i++) {
    const e = contact[`guessed_email_${i}`];
    if (e) emailList.push({ key: `guessed_email_${i}`, email: e });
  }

  if (emailList.length === 0) return results;

  // Şirket pattern analizi
  const companyDomain = extractDomainFromWebsite(contact.website);
  const companyEmails = await getCompanyEmails(contact.company_name);
  const { pattern, confidence } = detectPattern(companyEmails, companyDomain);

  // Her email için puan hesapla
  for (const { key, email } of emailList) {
    const normalizedEmail = email.toLowerCase().trim();
    const domain = extractDomain(normalizedEmail);

    // 8 kriter
    const syntax = syntaxCheck(normalizedEmail);
    const domainScore = await domainCheck(domain, dnsCache);
    const { score: mxScore } = await mxCheck(domain, dnsCache);
    const companyMatch = companyDomainMatch(domain, contact.website);
    const patternScore = checkPatternMatch(normalizedEmail, pattern, contact.first_name, contact.last_name, companyDomain);
    const personalScore = personalAddressCheck(normalizedEmail, contact.first_name, contact.last_name);
    const freeMailScore = freeMailCheck(domain);
    const roleScore = roleBasedCheck(normalizedEmail);

    const totalScore = syntax + domainScore + mxScore + companyMatch + patternScore + personalScore + freeMailScore + roleScore;

    results[key] = totalScore;
  }

  return results;
}

// ── Toplu Puanlama (Birden Fazla Kontak) ──
export async function scoreContacts(contactIds) {
  const results = [];
  let contacts;

  if (contactIds && contactIds.length > 0) {
    // Belirli kontakları al
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds);
    if (error) throw new Error(error.message);
    contacts = data;
  } else {
    // Tüm pending kontakları al (email_sent = false)
    let allContacts = [];
    let from = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('email_sent', false)
        .range(from, from + limit - 1);

      if (error) throw new Error(error.message);
      if (data && data.length > 0) {
        allContacts = allContacts.concat(data);
        from += limit;
        if (data.length < limit) hasMore = false;
      } else {
        hasMore = false;
      }
    }
    contacts = allContacts;
  }

  if (!contacts || contacts.length === 0) {
    return { results: [], totalScored: 0 };
  }

  console.log(`[Validation] Scoring ${contacts.length} contacts...`);

  for (const contact of contacts) {
    try {
      const scores = await scoreEmails(contact);
      
      // Skorları DB'ye kaydet
      const scoresJson = JSON.stringify(scores);
      const { error: updateError } = await supabase
        .from('contacts')
        .update({ email_scores: scoresJson })
        .eq('id', contact.id);

      if (updateError) {
        console.error(`[Validation] ⚠️ DB write FAILED for ${contact.first_name} ${contact.last_name}:`, updateError.message);
        
        // Schema cache hatası varsa bildir
        if (updateError.message.includes('schema') || updateError.message.includes('column')) {
          console.error(`[Validation] 💡 Supabase SQL Editor'da çalıştırın: NOTIFY pgrst, 'reload schema';`);
        }
      } else {
        console.log(`[Validation] ✓ DB saved: ${contact.first_name} ${contact.last_name}`);
      }

      results.push({
        contactId: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        scores
      });

      console.log(`[Validation] ✓ ${contact.first_name} ${contact.last_name}: ${JSON.stringify(scores)}`);
    } catch (err) {
      console.error(`[Validation] Error scoring contact ${contact.id}:`, err.message);
      results.push({
        contactId: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        scores: {},
        error: err.message
      });
    }
  }

  console.log(`[Validation] Scoring complete: ${results.length} contacts processed`);

  return { results, totalScored: results.length };
}

// ── SCORE_THRESHOLD export ──
export const SCORE_THRESHOLD = 50;
