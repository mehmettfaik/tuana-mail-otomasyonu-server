import dotenv from 'dotenv';
dotenv.config();

const APOLLO_API_URL = 'https://api.apollo.io';
const API_KEY = process.env.APOLLO_API_KEY;

/**
 * Helper to make requests to Apollo API
 */
async function apolloRequest(endpoint, method = 'GET', data = null) {
  if (!API_KEY) {
    throw new Error('APOLLO_API_KEY is not defined in .env');
  }

  const url = `${APOLLO_API_URL}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'x-api-key': API_KEY
  };

  const options = {
    method,
    headers,
  };

  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    
    // Apollo sometimes returns 429 for rate limits
    if (response.status === 429) {
      const errorMsg = 'Apollo Rate Limit Exceeded (429). Please wait before making more requests.';
      console.warn(`[Apollo Service] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const responseData = await response.json();

    if (!response.ok) {
      console.error(`[Apollo Service] Error ${response.status}:`, responseData);
      throw new Error(responseData.error || `Apollo API returned ${response.status}`);
    }

    return responseData;
  } catch (error) {
    console.error(`[Apollo Service] Request Failed to ${endpoint}:`, error.message);
    throw error;
  }
}

/**
 * Search for people at a specific domain with specific titles.
 * @param {string} domain - e.g. 'tuana.com.tr'
 * @param {Array<string>} titles - e.g. ['CEO', 'Founder', 'Director']
 * @returns {Promise<Array>} Array of person objects
 */
export async function searchPeopleByDomain(domain, titles = ['CEO', 'Founder', 'Owner', 'Managing Director', 'Marketing']) {
  if (!domain) return [];

  const body = {
    q_organization_domains: domain,
    person_titles: titles,
    per_page: 3 // Limit to top 3 matching people to save credits
  };

  const data = await apolloRequest('/v1/mixed_people/search', 'POST', body);
  return data.people || [];
}

/**
 * Request email enrichment for a specific person. (Consumes 1 Credit)
 * Note: If the person is already in your Apollo contacts, this might not consume a credit.
 * @param {string} personId - The ID of the person returned from search
 * @returns {Promise<Object>} The enriched person object containing email
 */
export async function enrichPerson(personId) {
  if (!personId) throw new Error('personId is required');

  // We use the contact creation endpoint or match endpoint.
  // /v1/people/match allows revealing email if you have their details.
  // Wait, if we already have the personId, we can just fetch their details or unlock them.
  // In Apollo, to reveal an email for an existing person ID, we often use /v1/contacts 
  
  // Actually, we can use the mixed_people/search with contact_emails_status to reveal?
  // Let's use /v1/people/match which requires email or (first_name, last_name, organization_name)
  // Wait, the official way to "unlock" an email if you have person_id is to POST /v1/contacts
  // or /v1/people/match ? No, it's /v1/contacts.
  // Let's just create a contact by providing person_id. Apollo will enrich and return the contact.
  
  const body = {
    person_id: personId
  };

  // Note: this will add the person to your Apollo CRM and reveal their email (uses 1 credit)
  const data = await apolloRequest('/v1/contacts', 'POST', body);
  return data.contact || data.person;
}

/**
 * Add a contact to an Apollo Sequence (Campaign).
 * @param {string} contactId - The contact ID (or person ID if Apollo accepts it)
 * @param {string} sequenceId - The ID of the sequence
 * @returns {Promise<Object>} Result of the addition
 */
export async function addContactToSequence(contactId, sequenceId) {
  if (!contactId || !sequenceId) throw new Error('contactId and sequenceId are required');

  const body = {
    contact_ids: [contactId],
    emailer_campaign_id: sequenceId
  };

  const data = await apolloRequest(`/v1/emailer_campaigns/${sequenceId}/add_contact_ids`, 'POST', body);
  return data;
}
