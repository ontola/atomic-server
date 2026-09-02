# PauseBot

PauseBot is a Discord bot designed to streamline the onboarding pipeline for PauseAI. It listens for new members joining the server and, once they are assigned specific country roles, automatically sends an email to the corresponding country coordinator using the MailerSend API. It also automatically records new joining users to an Airtable database. It reports its email activities to a designated Discord channel.

## Features

- **Automatic Onboarding Emails**: Monitors new users and waits a few minutes. If a user is given a registered country role, an email is automatically sent to the country's coordinator.
- **Airtable Integration**: Records new member details (Discord ID, username, nick, global name, join date, and role IDs) to an Airtable table.
- **Airtable/Webhook to Discord Syncing**: Exposes a secure REST endpoint (`/webhook/add_role`) natively powered by a web server that accepts POST requests securely authenticated with a `WEBHOOK_SECRET`. Allows Airtable automations to seamlessly assign Discord roles to members based on Airtable state updates.
- **Member Export**: Administrators and authorized users can use the `!export_members` command to download a CSV file containing all members and their roles.
- **Discord Notification Channel**: Logs successful and failed email attempts directly to a designated Discord channel (e.g., `#onboarding-pipeline`).
- **Role-based Logic**: Easily map new or existing Discord Role IDs to specific email addresses.
- **CRM Events (optional)**: When `CRM_WEBHOOK_URL` and `CRM_WEBHOOK_SECRET` are set, the bot posts signed `member.joined`, `member.roles_updated` and `member.left` events to the PauseAI CRM (`pauseai-automation/crm`), which links Discord accounts to volunteer records and maps country roles to chapters. Unset means off; a CRM outage never affects onboarding.

## Prerequisites

- Python 3.8+
- A Discord Bot Token
- A MailerSend API Key
- An Airtable Personal Access Token (optional, if you want an Airtable log)

## Setup

1. **Clone the repository:**

   ```bash
   git clone <your-repository-url>
   cd PauseBot
   ```

2. **Create a virtual environment (optional but recommended):**

   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows use `venv\Scripts\activate`
   ```

3. **Install dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

4. **Environment Variables:**
   Copy the example environment file and fill in your details:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and configure the following variables:
   - `DISCORD_TOKEN`: Your Discord bot token.
   - `MAILERSEND_API_KEY`: Your MailerSend API Key.
   - `AIRTABLE_PERSONAL_ACCESS_TOKEN`: The PAT from your Airtable account.
   - `WEBHOOK_SECRET`: A secret string of your choosing. Required if using the webhooks for assigning roles.
   - `PORT`: (Optional) Custom port for the web server to run over (defaults to 8080).
   - `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET`: (Optional) Where to send signed member events for the PauseAI CRM. Signature: HMAC-SHA256 of `<timestamp>.<body>`, sent in `X-PauseBot-Signature` / `X-PauseBot-Timestamp`.

5. **Configure Roles and Channels (in `main.py`):**
   - Update `AIRTABLE_BASE_ID` with your target Airtable base's ID.
   - Update `AIRTABLE_TABLE_NAME` with the table name where members will be recorded.
   - Update `ONBOARDING_PIPELINE_CHANNEL_ID` with the channel ID where the bot should log its actions.
   - Update the `COUNTRY_ROLES` dictionary with the Discord Role IDs and their corresponding coordinator email addresses.

## Running the Bot

Run the bot directly via Python:

```bash
python main.py
```

## Deployment

This bot is designed to be easily deployed to containerized environments or platforms like Railway or Heroku. Make sure to define your environment variables (`DISCORD_TOKEN`, `MAILERSEND_API_KEY`, etc.) in your deployment platform's dashboard.
