import { supabase } from '../supabaseClient.js';
import * as apolloService from './apolloService.js';

// ── In-memory state ──
const state = {
  isRunning: false,
  isPaused: false,
  pausedUntil: null,
  pauseReason: null,
  totalProcessed: 0,
  totalAddedToSequence: 0,
  totalFailed: 0,
  totalTarget: 0,
  dashboardMessage: 'Henüz başlatılmadı.',
  errors: [],        // Son hataları tutar (max 50)
  currentCompany: null,
};

const MIN_DELAY_MS = 10_000; // Apollo API hız sınırlarına takılmamak için 10 saniye bekleme
const MAX_DELAY_MS = 25_000; // 25 saniye

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addError(msg) {
  state.errors.unshift({ message: msg, time: new Date().toISOString() });
  if (state.errors.length > 50) state.errors.length = 50;
}

// ── Domain Çıkarma ──
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

// ── Ana Otomasyonu Başlat ──
export async function startApolloAutomation(sequenceId, targetTitles) {
  if (state.isRunning) return { success: false, message: 'Otomasyon zaten çalışıyor.' };
  if (!process.env.APOLLO_API_KEY) return { success: false, message: 'APOLLO_API_KEY eksik.' };
  if (!sequenceId) return { success: false, message: 'Sequence (Kampanya) ID si gereklidir.' };

  // Durumu sıfırla
  state.isRunning = true;
  state.isPaused = false;
  state.pausedUntil = null;
  state.pauseReason = null;
  state.totalProcessed = 0;
  state.totalAddedToSequence = 0;
  state.totalFailed = 0;
  state.errors = [];
  state.dashboardMessage = 'Firma listesi yükleniyor...';

  // Benzersiz firmaları tespit etmek için, henüz işlem görmemiş kontakların veya firmaların listesini al
  // Mevcut yapınızda firmalar `contacts` tablosunda `company_name` ve `website` alanlarında tutuluyor.
  // email_sent = false olan kontakların firmalarını alacağız.
  
  let allCompanies = new Map();
  let from = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('contacts')
      .select('company_name, website, id')
      .eq('email_sent', false)
      .not('website', 'is', null) // Websitesi olmayan firmaları Apollo'da bulmak zor, o yüzden sadece olanlar
      .range(from, from + limit - 1);

    if (error) {
      state.isRunning = false;
      state.dashboardMessage = 'Firmalar yüklenemedi.';
      addError('DB hatası: ' + error.message);
      return { success: false, message: error.message };
    }

    if (data && data.length > 0) {
      data.forEach(c => {
        const domain = extractDomainFromWebsite(c.website);
        if (domain && !allCompanies.has(domain)) {
          allCompanies.set(domain, { domain, companyName: c.company_name, contactIdToUpdate: c.id });
        }
      });
      from += limit;
      if (data.length < limit) hasMore = false;
    } else {
      hasMore = false;
    }
  }

  const companiesToProcess = Array.from(allCompanies.values());
  state.totalTarget = companiesToProcess.length;

  if (state.totalTarget === 0) {
    state.isRunning = false;
    state.dashboardMessage = 'İşlenecek firma bulunamadı (Websitesi olan ve email gönderilmemiş firma yok).';
    return { success: false, message: 'İşlenecek firma bulunamadı.' };
  }

  state.dashboardMessage = ` ${state.totalTarget} farklı firma işlenecek...`;
  console.log(`[Apollo Automation] Başlıyor: ${state.totalTarget} farklı firma.`);

  // Background'da çalıştır
  processCompanies(companiesToProcess, sequenceId, targetTitles);

  return { success: true, message: 'Apollo otomasyonu başlatıldı.' };
}

// ── Firmaları İşleme Döngüsü ──
async function processCompanies(companies, sequenceId, targetTitles) {
  for (const company of companies) {
    if (!state.isRunning) break;

    state.currentCompany = company.domain;
    state.totalProcessed++;

    console.log(`[Apollo Automation] İşleniyor: ${company.domain} (${state.totalProcessed}/${state.totalTarget})`);

    try {
      // 1. Apollo'da bu domain'de ilgili kişileri ara
      const persons = await apolloService.searchPeopleByDomain(company.domain, targetTitles);

      if (!persons || persons.length === 0) {
        console.log(`[Apollo Automation] ${company.domain} için hedef profilde kimse bulunamadı.`);
        // Veritabanında bu firmaya ait kontakları 'email_sent=true' yapabiliriz ki bir daha takılmasın,
        // ama kullanıcının bileceği bir durum. Şimdilik sadece geçelim.
        continue;
      }

      // 2. Bulunan ilk uygun kişiyi seç (veya hepsini)
      // Kredi israfını önlemek için sadece en iyi 1 kişiyi işleyelim
      const targetPerson = persons[0]; 
      
      console.log(`[Apollo Automation] ${company.domain} için kişi bulundu: ${targetPerson.first_name} ${targetPerson.last_name} (${targetPerson.title})`);

      // 3. Kişinin e-postasını bul (Enrichment - Kredi Harcar)
      const enrichedPerson = await apolloService.enrichPerson(targetPerson.id);

      if (enrichedPerson && enrichedPerson.email) {
        const email = enrichedPerson.email.toLowerCase();

        // Apollo email'i Verified döndürmüyorsa (örneğin Catch-all ise) risk alıp almamak size kalmış
        // Biz burada güvenilir olması için verified (doğrulanmış) olmasına bakabiliriz, 
        // ancak bazen status doğrudan dönmeyebilir. Şimdilik email varsa devam edelim.

        console.log(`[Apollo Automation] Email bulundu: ${email} (Firma: ${company.domain})`);

        // 4. Supabase DB'yi Güncelle
        // Eski kaydın existing_email kısmına yazıyoruz ve Apollo skoru veriyoruz
        const { error: updateError } = await supabase
          .from('contacts')
          .update({
            existing_email: email,
            email_scores: JSON.stringify({ 'Apollo': 100 }),
            email_sent: true, // Apollo göreceği için gönderildi olarak işaretle
            sent_at: new Date().toISOString()
          })
          .eq('id', company.contactIdToUpdate);

        if (updateError) {
           console.error(`[Apollo Automation] DB Update Error for ${email}:`, updateError.message);
        }

        // 5. Apollo Kampanyasına (Sequence) Ekle
        // Apollo'da enrich edilen kişinin id'si genelde 'contact.id' olur.
        const contactId = enrichedPerson.contact_id || enrichedPerson.id;
        
        await apolloService.addContactToSequence(contactId, sequenceId);
        
        state.totalAddedToSequence++;
        state.dashboardMessage = `✅ ${company.domain} - ${email} kampanyaya eklendi. (${state.totalProcessed}/${state.totalTarget})`;
        console.log(`[Apollo Automation] ✓ Başarıyla Sequence'a eklendi.`);

      } else {
        console.log(`[Apollo Automation] ${company.domain} için kişinin emaili bulunamadı.`);
        addError(`${company.domain} - Kişi bulundu ama email açılamadı.`);
      }

    } catch (error) {
      console.error(`[Apollo Automation] Hata (${company.domain}):`, error.message);
      state.totalFailed++;
      addError(`${company.domain} hatası: ${error.message}`);
      
      if (error.message.includes('429')) {
         state.dashboardMessage = 'Apollo API sınırına ulaşıldı. 60 sn bekleniyor...';
         await sleep(60_000);
      }
    }

    // Rate Limit Koruma (API'yi yormamak için her firma arası bekle)
    if (state.isRunning) {
      const delay = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
      state.dashboardMessage = `Sıradaki firma için ${Math.round(delay/1000)}s bekleniyor...`;
      await sleep(delay);
    }
  }

  if (state.isRunning) {
    state.isRunning = false;
    state.dashboardMessage = `🎉 Apollo otomasyonu tamamlandı! ${state.totalAddedToSequence} kişi kampanyaya eklendi.`;
  }
  state.currentCompany = null;
}

export function stopApolloAutomation() {
  state.isRunning = false;
  state.dashboardMessage = 'Kullanıcı tarafından durduruldu.';
  state.currentCompany = null;
}

export function getApolloStatus() {
  return {
    isRunning: state.isRunning,
    isPaused: state.isPaused,
    totalProcessed: state.totalProcessed,
    totalAddedToSequence: state.totalAddedToSequence,
    totalFailed: state.totalFailed,
    totalTarget: state.totalTarget,
    message: state.dashboardMessage,
    currentCompany: state.currentCompany,
    errors: state.errors.slice(0, 20),
  };
}
