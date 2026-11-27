# MVP Scope: MetroNest Maintenance Agent

## Build

- Local web dashboard for property managers.
- Tenant chat through Telegram, or through the `/api/chat` endpoint for testing.
- Conversational intake through the OpenAI Responses API with a strict JSON schema, with rules based intake as the fallback.
- Deterministic triage engine for category, urgency, risk, vendor, and message drafts.
- Contractor dispatch simulation for top approved vendors.
- Landlord auto accept setting for urgent jobs under a quote limit. Off by default.
- Manual quote review for less urgent work.
- Telegram connector using long polling.
- Telegram reply delay and typing indicator for a more natural tenant experience.

## Not In Scope

- Real vendor dispatch.
- Real landlord messaging.
- Real contractor messaging unless approved contacts are added later.
- Payments, invoices, or production tenant data.
- Full user accounts.
- Telegram webhooks. The bot polls, so it needs no public URL.

## Connection Requirements

- Telegram bot token from BotFather for live tenant chat.
- Optional OpenAI API key for conversational intake. Without one, the rules based intake runs on its own.
- Contractor contact details if the demo should send real messages instead of using in app simulated responses.
