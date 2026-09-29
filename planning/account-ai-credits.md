# Included AI for SaaS accounts

The product/operations contract lives in the sibling atomic-saas repository,
`planning/AI_ACCESS_AND_PRICING.md`. AI credits belong to the signed-in account;
drive hosting subscriptions remain independent.

- [x] Hosted provider uses the authenticated control-plane endpoint, never a
  company API key in the browser. BYOK and local Ollama remain available.
- [x] SaaS chat opens directly, without onboarding or a required model selection.
  The included default also handles saved agents without a configured provider.
- [x] First-use disclosure sits in the composer; explicit Send records consent
  before sending context. Automatic handoffs remain editable until consent.
- [x] Account balance/reset shown in chat and portal; backend enforces spend.
- [x] Setup/transport component tests and TypeScript/build validation.
- [ ] Paired CI, staging deployment, and a real funded-provider conversation plus
  generated title. Local tests use simulated provider responses, not paid inference.
- [ ] Production release after staging verification.

Remove this checklist when the deployment checks are complete; retain the product
contract and operating limits in atomic-saas.
