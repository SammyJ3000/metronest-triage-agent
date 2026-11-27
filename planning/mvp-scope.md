# MVP Scope: MetroNest Maintenance Agent

## Build

- Local web dashboard for property managers.
- Tenant chat simulator for filming and testing.
- Deterministic triage engine for category, urgency, risk, vendor, and message drafts.
- Contractor dispatch simulation for top approved vendors.
- Landlord auto-accept settings for urgent jobs under a quote limit.
- Manual quote review for less urgent work.
- Optional Telegram polling connector.
- Telegram reply delay and typing indicator for a more natural tenant experience.

## Not In Scope

- Real vendor dispatch.
- Real landlord messaging.
- Real contractor messaging unless approved contacts are added later.
- Payments, invoices, or production tenant data.
- Full user accounts.

## Connection Requirements

- Telegram bot token from BotFather for live tenant chat.
- Optional public HTTPS URL if using Telegram webhooks instead of local polling.
- Optional AI API key if the triage logic is later upgraded from deterministic rules to an LLM.
- Contractor contact details if the demo should send real messages instead of using in-app simulated responses.
