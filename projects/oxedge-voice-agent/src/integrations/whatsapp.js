import { requestJson } from './http.js';

/**
 * WhatsApp Cloud API recap after the call.
 *
 * Messages a business starts must use a template approved by Meta, so this sends
 * WHATSAPP_TEMPLATE_EN / WHATSAPP_TEMPLATE_AR with two body parameters:
 *   {{1}} the caller's first name, {{2}} the booking sentence.
 */
export function createMessenger(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const { token, phoneNumberId, graphVersion, templates } = config.whatsapp;
  const enabled = Boolean(token && phoneNumberId && (templates.en || templates.ar));
  if (!enabled) {
    return { enabled: false, async sendRecap() { return null; } };
  }

  return {
    enabled: true,
    async sendRecap({ to, language = 'en', name, bookingSentence }) {
      const template = templates[language] || templates.en || templates.ar;
      const languageCode = templates[language] ? language : (templates.en ? 'en' : 'ar');
      const data = await requestJson(fetchImpl, 'WhatsApp', `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          messaging_product: 'whatsapp',
          to: to.replace(/[^\d]/g, ''),
          type: 'template',
          template: {
            name: template,
            language: { code: languageCode },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: (name || '').split(/\s+/)[0] || (languageCode === 'ar' ? 'هلا' : 'there') },
                { type: 'text', text: bookingSentence },
              ],
            }],
          },
        },
      });
      return { id: data?.messages?.[0]?.id ?? null };
    },
  };
}
