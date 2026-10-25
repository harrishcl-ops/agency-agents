// Builds Layla's Vapi assistant definition. scripts/setup.js sends this to Vapi.

export const FIRST_MESSAGES = {
  en: {
    inbound: "Hi, thanks for calling OxEdge. I'm Layla, the AI assistant, and this call is recorded for quality. How can I help you today?",
    outbound: "Hi{% if customer_name %} {{ customer_name }}{% endif %}, this is Layla, OxEdge's AI assistant, calling from Dubai. You recently asked us about a project. Is now a good time for a quick two-minute chat?",
  },
  ar: {
    inbound: 'مرحبا، شكراً لاتصالك بأوكس إدج. معك ليلى، المساعدة الذكية، والمكالمة مسجلة لضمان الجودة. كيف أقدر أساعدك اليوم؟',
    outbound: 'مرحبا{% if customer_name %} {{ customer_name }}{% endif %}، معك ليلى، المساعدة الذكية من أوكس إدج في دبي. تواصلت معنا مؤخراً بخصوص مشروع. يناسبك نتكلم دقيقتين الحين؟',
  },
};

const SPOKEN_LANGUAGE = {
  en: 'English. If the caller speaks Arabic, apologise briefly and continue in simple English, and offer an Arabic-speaking callback from the team.',
  ar: 'Gulf Arabic (Emirati / Khaleeji dialect). If the caller switches to English, reply in English.',
};

const TOOL_MESSAGES = {
  en: { check: 'One moment, let me check the calendar.', book: 'Booking that for you now.' },
  ar: { check: 'لحظة، خلني أشيك على المواعيد.', book: 'ثواني، أحجز لك الموعد.' },
};

const BOOKING_STEPS = {
  live: `3. Offer a free 30-minute discovery call with the OxEdge team. Use check_availability, offer at most two of the returned times, and when they pick one, call book_discovery_call with that slot's exact start value.
4. Confirm the booked time, tell them they'll get a WhatsApp recap, thank them and end the call with the endCall tool.`,
  // Demo mode has no webhook server, so Layla takes a preferred time instead of booking one.
  demo: `3. Offer a free 30-minute discovery call with the OxEdge team. Ask which weekday and time of day suits them, and say the team will confirm the exact time on WhatsApp.
4. Repeat their preference back, thank them and end the call with the endCall tool.`,
};

export function systemPrompt({ language, knowledge, transferEnabled, demo = false }) {
  return `You are Layla, the AI phone receptionist for OxEdge, a web agency and custom software company in Dubai. You are on a live phone call; everything you write is spoken aloud.

Today is {{"now" | date: "%A %d %B %Y, %I:%M %p", "Asia/Dubai"}} in Dubai.
{% if direction == "outbound" %}This is an outbound follow-up call. You are calling the person because they asked OxEdge about a project. {{ lead_context }}
If they say it's a bad time, ask when to call back, thank them and end the call.{% else %}This is an inbound call to OxEdge.{% endif %}

# Language
Speak ${SPOKEN_LANGUAGE[language] ?? SPOKEN_LANGUAGE.en}

# Your goals, in order
1. Understand what the caller needs (website, e-commerce, mobile app, custom software, AI automation, or something else).
2. Collect, one question at a time: their name, company, what they need, rough budget range, timeline, and whether WhatsApp on this number is fine for follow-up. Email is optional.
${demo ? BOOKING_STEPS.demo : BOOKING_STEPS.live}

# How to speak
- One or two short sentences per turn, under 35 words. Ask one question at a time.
- Warm, professional, natural. Use the caller's name once you know it.
- Say times like "Tuesday at eleven in the morning", never ISO dates or codes.
- No lists, markdown, emojis or URLs.

# Rules
- Never quote prices, discounts or delivery dates for OxEdge work. Say the team sends a tailored proposal after the discovery call. You may ask for the caller's budget.
- Never invent facts about OxEdge. If the answer isn't in the company information below, say the team will cover it on the discovery call.
- If asked whether you are a human, say you are OxEdge's AI assistant.
${transferEnabled
    ? '- If the caller asks for a person, is frustrated, or is a hot lead who wants to talk now, say you will connect them and use the transferCall tool.'
    : '- If the caller asks for a person, say a team member will call them back today, and make sure you have their name and need.'}
- If the caller is not a potential client (job seekers, sales pitches, spam), be polite, take a short message and end the call.
- Do not discuss topics unrelated to OxEdge.

# Company information
${cleanKnowledge(knowledge)}`;
}

/** Drops editor comments and unfinished TODO lines so Layla never reads them out. */
export function cleanKnowledge(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/\bTODO\b/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: "Caller's name" },
    company: { type: 'string', description: "Caller's company or business name" },
    email: { type: 'string', description: 'Email address if given' },
    need: { type: 'string', description: 'What they want built, in a short phrase' },
    budget: { type: 'string', description: 'Budget range as stated, e.g. "AED 30-50k"' },
    preferred_time: { type: 'string', description: 'When they would like the discovery call, if they said' },
    timeline: { type: 'string', description: 'When they want it, as stated' },
    whatsapp_ok: { type: 'boolean', description: 'False only if the caller declined WhatsApp follow-up' },
    wants_human: { type: 'boolean', description: 'True if they asked to speak to a person' },
    lead_quality: { type: 'string', enum: ['hot', 'warm', 'cold', 'not_a_lead'], description: 'hot = clear need, budget and timeline; not_a_lead = spam, job seekers, vendors' },
  },
};

export function buildAssistant({ config, language, knowledge }) {
  const { agent, publicUrl, webhookSecret } = config;
  const transferEnabled = Boolean(agent.transferNumber);
  const msgs = TOOL_MESSAGES[language] ?? TOOL_MESSAGES.en;
  // Without PUBLIC_URL there is no webhook server yet: Layla can still talk and Vapi still
  // extracts the lead, but she can't check the calendar or book.
  const demo = !publicUrl;

  const bookingTools = [
    {
      type: 'function',
      messages: [{ type: 'request-start', content: msgs.check }],
      function: {
        name: 'check_availability',
        description: 'Returns up to three free 30-minute discovery-call slots with the OxEdge team, in Dubai time. Call before offering any time.',
        parameters: {
          type: 'object',
          properties: {
            day_hint: { type: 'string', description: 'The day the caller prefers, in their words: "tomorrow", "Tuesday", "next week", or YYYY-MM-DD. Omit for the soonest slots.' },
          },
        },
      },
    },
    {
      type: 'function',
      messages: [{ type: 'request-start', content: msgs.book }],
      function: {
        name: 'book_discovery_call',
        description: 'Books the discovery call in the OxEdge calendar. Only call after the caller has chosen one of the slots from check_availability.',
        parameters: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'The exact start value of the chosen slot from check_availability' },
            name: { type: 'string', description: "Caller's name" },
            company: { type: 'string', description: "Caller's company, if known" },
            email: { type: 'string', description: "Caller's email, if given" },
            need: { type: 'string', description: 'What they want built, in a short phrase' },
          },
          required: ['start', 'name'],
        },
      },
    },
  ];
  const tools = [...(demo ? [] : bookingTools), { type: 'endCall' }];

  if (transferEnabled) {
    tools.push({
      type: 'transferCall',
      destinations: [{
        type: 'number',
        number: agent.transferNumber,
        description: 'The OxEdge team. Use when the caller asks for a person, is frustrated, or is a hot lead who wants to talk now.',
        message: language === 'ar' ? 'لحظة، بحولك لأحد من الفريق.' : 'One moment, I’m connecting you to the team now.',
      }],
    });
  }

  return {
    name: `Layla (OxEdge ${language.toUpperCase()})`,
    firstMessage: FIRST_MESSAGES[language]?.inbound ?? FIRST_MESSAGES.en.inbound,
    firstMessageMode: 'assistant-speaks-first',
    metadata: { language, app: 'oxedge-voice-agent' },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: language === 'ar' ? 'ar' : 'en',
      keyterm: ['OxEdge', 'Layla', 'WhatsApp', 'e-commerce', 'Dubai'],
    },
    model: {
      provider: 'anthropic',
      model: agent.llmModel,
      temperature: 0.4,
      maxTokens: 250,
      messages: [{ role: 'system', content: systemPrompt({ language, knowledge, transferEnabled, demo }) }],
      tools,
    },
    voice: {
      provider: '11labs',
      model: agent.voiceModel,
      voiceId: agent.voiceIds[language] ?? agent.voiceIds.en,
      ...(agent.voiceModel === 'eleven_flash_v2_5' ? { language } : {}),
    },
    ...(demo ? {} : {
      server: {
        url: `${publicUrl}/vapi/webhook`,
        timeoutSeconds: 20,
        headers: { Authorization: `Bearer ${webhookSecret}` },
      },
      serverMessages: ['tool-calls', 'end-of-call-report'],
    }),
    endCallMessage: language === 'ar' ? 'شكراً لك، مع السلامة.' : 'Thanks for calling OxEdge. Goodbye!',
    maxDurationSeconds: 600,
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: LEAD_SCHEMA },
    },
  };
}

/** Per-call overrides for an outbound call placed by scripts/call.js. */
export function outboundOverrides({ language, customerName, leadContext }) {
  return {
    firstMessage: FIRST_MESSAGES[language]?.outbound ?? FIRST_MESSAGES.en.outbound,
    variableValues: {
      direction: 'outbound',
      customer_name: customerName || '',
      lead_context: leadContext ? `What we know: ${leadContext}` : '',
    },
  };
}
