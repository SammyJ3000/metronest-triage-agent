# Directive: Property Maintenance Triage Agent

## Goal

Collect tenant maintenance issues through chat, ask for missing details, classify the problem, and prepare a manager-ready work order with draft messages for the tenant, vendor, and landlord.

## Required Inputs

- Tenant name
- Property address and unit number
- Issue description
- Active property or safety risk
- Access permission or scheduling instruction
- At least 3 photos from the tenant

## Expected Outputs

- Work order reference
- Category
- Urgency
- Risk summary
- Rough price estimate
- Recommended vendor
- Recommended next action
- Contractor dispatch plan
- Contractor responses and quotes
- Confirmed contractor, when approved
- Draft tenant reply
- Draft vendor dispatch message
- Draft landlord update

## Tools and Scripts

- `executions/triage-engine.mjs`: deterministic intake, field extraction, classification, vendor routing, and message drafting.
- `server.mjs`: local dashboard API and web app server.
- `executions/telegram-polling-bot.mjs`: optional Telegram connector.

## Business Rules

- Establish what is wrong before asking for identity, safety follow-up, access or photos.
- A category alone, such as "it's electrical", is not a description; ask what has happened.
- Natural new-report openers such as "I have an issue" start a fresh report when a prior issue exists. Preserve old work orders, but never carry risk, permission or photos into the new report.
- Emergency and high-risk issues should be surfaced for manager approval quickly.
- Emergency and high-risk issues may contact the top three approved contractors for the relevant trade.
- Routine issues should default to landlord quote review before contractor dispatch.
- Landlords can enable auto-accept for urgent work under a chosen quote limit.
- If a contractor is confirmed, other open contractor requests should be marked unsuccessful.
- Contractor contact is simulated in the MVP unless real contractor Telegram, SMS, WhatsApp, or email channels are connected.
- Vendor and landlord messages are drafts only in the MVP.
- The tool should not send vendor, landlord, or external messages without explicit human approval.
- If required fields are missing, the chat agent should ask the tenant only for the next useful missing detail.
- Saved access preferences may be shown to the tenant, but they must not be treated as approval for the current job.
- The tenant must explicitly confirm access approval or ask the contractor to arrange a time for each maintenance request.

## Edge Cases

- Tenant provides only a vague issue.
- Tenant provides an address without a name.
- Tenant reports water, smoke, lockout, or electrical sparking.
- Tenant gives access permission before all issue details are known.
- Tenant sends fewer than 3 photos.

## Definition of Done

- Tenant can submit a maintenance issue through the local chat simulator.
- The dashboard updates with a work order.
- The work order shows triage, vendor recommendation, and message drafts.
- The landlord can contact top contractors from the dashboard.
- Contractors can be simulated as accepting or declining with quote amounts and ETAs.
- The landlord can confirm a quote manually or enable auto-accept for urgent work under a quote limit.
- The request can be moved through visible statuses.
- Telegram can be connected with `TELEGRAM_BOT_TOKEN` for live chat intake.
