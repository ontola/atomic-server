# pauseai-automation

[![Netlify Status](https://api.netlify.com/api/v1/badges/290ed007-d791-4047-b486-ad6a3f7e818d/deploy-status)](https://app.netlify.com/projects/pauseai-automation/deploys)

This repository contains webhook endpoints for updating the payment status of paying members in Airtable, and, in [`crm/`](./crm), the **PauseAI CRM**: a volunteer, chapter and stakeholder management service for PauseAI Global and the national chapters. The CRM has its own README, docs and test suite; it is a separate package so this Netlify function keeps deploying unchanged.

## How it works

When a member completes a Stripe checkout, Stripe sends subscription webhook events to this service. The webhook reads the `client_reference_id` from the Stripe checkout session — this is the **Airtable record ID** of the member (set by the onboarding flow when a volunteer opts in to becoming a paying member). The webhook then fetches that Airtable record directly by ID and updates its payment status field.

> **Note:** Previously, `client_reference_id` was a Tally submission ID, and the webhook looked up the Airtable record by matching a dedicated field. With the migration to the custom onboarding flow, `client_reference_id` is now the Airtable record ID itself, so the lookup is a direct `find()` instead of a filtered search. The `TALLY_ID_FIELD_NAME` env var is no longer required.
