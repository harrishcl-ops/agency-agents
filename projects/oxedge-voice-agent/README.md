# OxEdge Voice Agent (MVP)

Layla is OxEdge's AI phone receptionist. She answers calls (or calls leads back) in English or Gulf Arabic, qualifies the lead, books a 30-minute discovery call, then logs everything and sends the caller a WhatsApp recap.

```
Caller ⇄ phone number ⇄ Vapi ─┬─ Deepgram (speech-to-text)
                              ├─ Claude (what Layla says)
                              ├─ ElevenLabs (Layla's voice)
                              └─ webhooks ─► this server ─┬─ Google Calendar (free slots, booking)
                                                          ├─ HubSpot (contact + call note)
                                                          ├─ WhatsApp (recap to caller)
                                                          └─ data/leads.jsonl (always)
```

Vapi runs the live call. This repo holds two things:

- **Layla's definition**: prompt, voice, tools and lead fields, in `src/assistant.js` and `knowledge/oxedge.md`. `npm run setup` pushes it to Vapi.
- **A small webhook server** (`src/`) that Vapi calls when Layla checks the calendar, books a slot, or finishes a call.

It needs Node 22 and has no npm dependencies.

## What works in this MVP

| | |
|---|---|
| Inbound calls | Layla answers, qualifies, and books a discovery call |
| Outbound follow-up | `npm run call -- +9715XXXXXXXX` has Layla call a lead (or you) |
| English + Arabic | One assistant per language (`LANGUAGES=en,ar`) |
| Booking | Free slots from Google Calendar, in Dubai business hours, with no double booking |
| Lead capture | Name, company, need, budget, timeline, lead quality, summary, transcript, recording link |
| CRM | HubSpot contact found by phone or created, with the call note attached |
| WhatsApp recap | Approved template with the booked time |
| Human handoff | Live transfer to `TEAM_TRANSFER_NUMBER` when a caller asks for a person |
| Works without integrations | Each integration is optional. Without them, slots come from business hours and leads go to `data/leads.jsonl` |

## Set up

### 1. Accounts
- **Vapi** (vapi.ai): create a private API key. Claude, Deepgram and ElevenLabs are billed through Vapi by default, so no separate keys are needed to start.
- **A phone number in Vapi.** A free Vapi number only takes inbound US calls. To call UAE mobiles, or to forward your du / e& line, import a Twilio or Telnyx number (Vapi dashboard → Phone Numbers → Import).

### 2. Configure
```bash
cp .env.example .env
# fill in PUBLIC_URL, WEBHOOK_SECRET, VAPI_API_KEY, VAPI_PHONE_NUMBER_ID
```
Edit `knowledge/oxedge.md` with OxEdge's real details. Layla only says what's written there, and lines marked TODO are left out until you fill them in.

### 3. Run the server
Deploy anywhere that runs Node or Docker and gives you an https URL (Render, Railway, Fly.io, a VPS):
```bash
npm start            # or: docker build -t layla . && docker run -p 3000:3000 --env-file .env -v layla-data:/app/data layla
```
For local testing, run `npm start` and expose it with `ngrok http 3000`. Then put the ngrok https URL in `PUBLIC_URL`.

Check it's up: `curl https://your-url/health` lists which integrations are connected.

### 4. Create Layla on Vapi
```bash
npm run setup
```
This creates the assistant(s), saves their IDs in `.vapi-state.json`, and connects your phone number to inbound calls. Re-run it whenever you change the prompt, knowledge file or settings: it updates Layla in place.

**Demo mode:** if `PUBLIC_URL` is empty, setup only needs `VAPI_API_KEY`. Layla then talks and captures leads, which show in the Vapi dashboard under Call Logs, but she takes a preferred time instead of booking one. Use the dashboard's "Talk to Assistant" button to try her in the browser before you deploy anything or buy a number.

### 5. Test call
```bash
npm run call -- +9715XXXXXXXX --force                  # Layla calls your phone
npm run call -- +9715XXXXXXXX --lang ar --name "Sara" --context "Asked about a delivery app"
```
UAE rules only allow marketing calls between 9am and 6pm Dubai time, so the script refuses outside those hours unless you add `--force` (use it only for calls to yourself).

You can follow each call live in the Vapi dashboard under Call Logs. When it ends, the lead appears in `data/leads.jsonl` and at `GET /leads` (send `Authorization: Bearer <WEBHOOK_SECRET>`).

## Optional integrations

**Google Calendar**
1. In Google Cloud, create a service account and download its JSON key.
2. In Google Calendar, share the team calendar with the service account's email, with "Make changes to events".
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON or base64) and `GOOGLE_CALENDAR_ID` (the calendar's ID, often its email address).

Events are created without attendee invites. The caller's details go in the event description.

**HubSpot**
Create a private app with `crm.objects.contacts.read` and `crm.objects.contacts.write`, then set `HUBSPOT_TOKEN`.

**WhatsApp (Meta Cloud API)**
WhatsApp only lets businesses start a conversation with an approved template. In WhatsApp Manager, create a Utility template such as `layla_recap` with two body variables:

> Hi {{1}}, thanks for speaking with Layla from OxEdge. {{2}} Reply here if you have any questions.

Make an Arabic version too if you use Arabic. Then set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_EN` and `WHATSAPP_TEMPLATE_AR`. The recap is skipped if the caller said no to WhatsApp or the call lasted under 20 seconds.

## Forwarding your existing OxEdge number
Keep your du / e& number. Forward it (always, or only when busy or unanswered) to the Twilio or Telnyx number connected in Vapi. Your provider sets up call forwarding. International forwarding charges come from du / e&.

## Tests
```bash
npm test
```
The tests cover slot finding (business hours, notice, busy times, English and Arabic day hints), booking and double-booking, end-of-call processing, webhook auth, the Vapi assistant definition, and the Google, HubSpot and WhatsApp request formats. They use fake HTTP, so no accounts are needed.

## Files
```
src/assistant.js        Layla's prompt, tools, voice, transcriber and lead fields
src/handlers.js         check_availability, book_discovery_call, end-of-call processing
src/slots.js            Dubai business-hours slot logic
src/server.js           Webhook server (/vapi/webhook, /health, /leads)
src/integrations/       Google Calendar, HubSpot, WhatsApp, local lead log
scripts/setup.js        Create or update Layla on Vapi
scripts/call.js         Place an outbound call
knowledge/oxedge.md     What Layla knows about OxEdge
```

## Before going live
- Fill in every TODO in `knowledge/oxedge.md`.
- Listen to 10 to 20 test calls in both languages. Adjust the prompt and pick the ElevenLabs voice you like (`ELEVENLABS_VOICE_ID_EN` / `_AR`).
- Layla tells callers she's an AI and that the call is recorded. Keep that for UAE PDPL compliance.
- For outbound campaigns, check your numbers and lists against the UAE telemarketing rules (calling hours, registered numbers, Do Not Call Registry).
- `data/leads.jsonl` contains personal data. Keep the volume private and back it up.
