import os
import urllib.parse
import datetime
import discord
import aiohttp
import asyncio
import csv
import io
import re
import hmac
import hashlib
import json
import uuid
from discord.ext import commands
from dotenv import load_dotenv
from aiohttp import web
# Load environment variables from .env file
load_dotenv()

DISCORD_TOKEN = os.getenv('DISCORD_TOKEN')
MAILERSEND_API_KEY = os.getenv('MAILERSEND_API_KEY')
AIRTABLE_PERSONAL_ACCESS_TOKEN = os.getenv('AIRTABLE_PERSONAL_ACCESS_TOKEN')
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET')
PORT = int(os.getenv('PORT', 8080))

# Optional: forward member events to the PauseAI CRM (pauseai-automation/crm).
# When CRM_WEBHOOK_URL is unset nothing is sent and the bot behaves as before.
CRM_WEBHOOK_URL = os.getenv('CRM_WEBHOOK_URL')
CRM_WEBHOOK_SECRET = os.getenv('CRM_WEBHOOK_SECRET')

ALLOWED_EXPORT_ROLE_ID = 1409324452545822793

# Developer / Production Environment Mode
DEVELOPER_MODE = os.getenv('DEVELOPER_MODE', 'false').lower() == 'true'
PAUSEAI_SERVER_ID = 1100491867675709580
MODERATORS_CHANNEL_ID = 1103655770693832775
MODERATORS_ROLE_ID = 1108034486479880236
YAGPDB_USER_ID = 204255221017214977
last_yagpdb_alert_time = None

ONBOARDING_PIPELINE_CHANNEL_ID = 1174807044990193775
AIRTABLE_BASE_ID = "appWPTGqZmUcs3NWu"
AIRTABLE_TABLE_ID = "tblxeqggeTWU7Y8ME"
GENERAL_DM = """Welcome to the PauseAI Global Discord, {user}!
We're delighted to have you join us. Please make sure you have also signed up via our Join form [here](https://pauseai.info/join). 
 
Feel free to introduce yourself in the <#1101804381755686972> – it's always nice to know who's joining us. 
 
If you’re looking for an immediate action to take, check out [MicroCommit](https://microcommit.io/onboarding?org=135fcd8d-8116-44af-b885-14df992f9a8c), a platform where you can follow us and get weekly small tasks anyone can help with!
 
We also conduct welcome calls where you can meet others who are joining PauseAI, you can check them out [here](https://luma.com/PauseAI?tag=welcome).
 
Lastly, you can find others near you who are organizing in communities: <#1171376873721298984>"""

# Unified definition for Countries (MailerSend Emails + YAGPDB Onboarder Pings)
COUNTRY_DATA = {
    1188719374941560925: {"name": "UK", "onboarders": [335365981276995594, 925051691798233089], "msg": "", "noDM": True, "email": None},
    1188717849980702781: {"name": "US", "onboarders": [732773275238793266], "msg": "", "email": None},
    1188719426552479824: {"name": "France", "onboarders": [456868543225528331], "msg": "", "email": None},
    1188719399117541396: {"name": "Germany", "onboarders": [775477651703726092], "msg": "", "email": "germany@pauseai.info"},
    1188719443954643035: {"name": "Netherlands", "onboarders": [1363472971141746718], "msg": "", "email": None},
    1188719729662234624: {"name": "Italy", "onboarders": [1217966947057139762], "msg": "", "email": None},
    1188720344882753566: {"name": "Spain", "onboarders": [758415679526797342], "msg": "", "email": None},
    1250075465008549938: {"name": "Canada", "onboarders": [719546151593967616, 800445163520524311], "msg": "", "email": "canada@pauseai.info"},
    1188719833555161089: {"name": "Nigeria", "onboarders": [1185890162027278446], "msg": "", "email": None},
    1188720325530243142: {"name": "Romania", "onboarders": [521285222990348290], "msg": "", "email": None},
    1188719500439343135: {"name": "Australia", "onboarders": [345795697792122891], "msg": "", "email": None},
    1188719860096712756: {"name": "Poland", "onboarders": [1405864336873881644], "msg": "", "email": None},
    1429216643459842129: {"name": "Serbia", "onboarders": [1060642083347632182], "msg": "", "email": None},
    1188719899401523330: {"name": "Sweden", "onboarders": [269204846572339211], "msg": "", "email": None},
    1188719610384633918: {"name": "Czech", "onboarders": [971680888960208926], "msg": "", "email": None},
    1256260218162122843: {"name": "Kenya", "onboarders": [853298855310000148], "msg": "", "email": None},
}

intents = discord.Intents.default()
intents.members = True # Required for on_member_join!
intents.message_content = True # Required for commands

from discord import app_commands
bot = commands.Bot(command_prefix='!', intents=intents)

# Shared aiohttp session — created once on startup, reused for all HTTP calls
http_session: aiohttp.ClientSession | None = None

def _crm_member_payload(member):
    return {
        "id": str(member.id),
        "username": member.name,
        "global_name": getattr(member, 'global_name', None),
        "nick": member.nick,
        "joined_at": member.joined_at.isoformat() if member.joined_at else None,
        "role_ids": [str(r.id) for r in member.roles if r.name != "@everyone"],
    }

async def crm_emit(event_type, member, **extra):
    """
    POST a signed event to the CRM. Signature is HMAC-SHA256 over
    "<unix timestamp>.<raw json body>" with CRM_WEBHOOK_SECRET, matching
    pauseai-automation/crm/src/lib/server/integrations/discord/webhook.ts.
    Never raises: a CRM outage must not affect Discord onboarding.
    """
    if not CRM_WEBHOOK_URL or not CRM_WEBHOOK_SECRET or http_session is None:
        return
    event = {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "at": datetime.datetime.now(datetime.UTC).isoformat(),
        "member": _crm_member_payload(member),
        **extra,
    }
    body = json.dumps(event, separators=(",", ":"), sort_keys=True)
    timestamp = str(int(datetime.datetime.now(datetime.UTC).timestamp()))
    signature = hmac.new(CRM_WEBHOOK_SECRET.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-PauseBot-Timestamp": timestamp,
        "X-PauseBot-Signature": signature,
    }
    for attempt in range(3):
        try:
            async with http_session.post(CRM_WEBHOOK_URL, data=body, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status < 500:
                    if response.status >= 400:
                        print(f"CRM rejected {event_type} for {member.name}: {response.status} - {await response.text()}")
                    return
                print(f"CRM error {response.status} for {event_type}, attempt {attempt + 1}")
        except Exception as e:
            print(f"CRM unreachable for {event_type} ({attempt + 1}/3): {e}")
        await asyncio.sleep(2 ** attempt)

async def handle_webhook(request):
    auth_header = request.headers.get("Authorization")
    if not WEBHOOK_SECRET:
        return web.json_response({"error": "Webhook secret not configured in the bot"}, status=500)
        
    if not auth_header or auth_header != f"Bearer {WEBHOOK_SECRET}":
        return web.json_response({"error": "Unauthorized"}, status=401)
        
    try:
        data = await request.json()
        user_id = data.get("user_id")
        role_id = data.get("role_id")
        
        if not user_id or not role_id:
            return web.json_response({"error": "Missing user_id or role_id"}, status=400)
            
        guild = bot.get_guild(PAUSEAI_SERVER_ID)
        if not guild:
            return web.json_response({"error": "Guild not found"}, status=500)
            
        member = guild.get_member(int(user_id))
        if not member:
            try:
                member = await guild.fetch_member(int(user_id))
            except discord.NotFound:
                return web.json_response({"error": "Member not found in guild"}, status=404)
            
        role = guild.get_role(int(role_id))
        if not role:
            return web.json_response({"error": f"Role {role_id} not found in guild"}, status=404)
            
        await member.add_roles(role)
        print(f"WEBHOOK: Added role '{role.name}' to {member.name}")
        return web.json_response({"success": True, "message": f"Added role {role.name} to {member.name}"})
        
    except Exception as e:
        print(f"WEBHOOK ERROR: {e}")
        return web.json_response({"error": str(e)}, status=500)

async def start_web_server():
    app = web.Application()
    app.router.add_post('/webhook/add_role', handle_webhook)
    
    # Simple healthcheck for the deployment platform
    async def healthcheck(request):
        return web.json_response({"status": "ok", "bot_user": str(bot.user) if bot.user else "Starting..."})
    app.router.add_get('/', healthcheck)
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()
    print(f"Web server started on port {PORT}")

async def setup_hook():
    global http_session
    http_session = aiohttp.ClientSession()
    bot.loop.create_task(start_web_server())
    await bot.tree.sync()

bot.setup_hook = setup_hook


async def find_airtable_record(discord_id):
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
        return None, None
        
    formula = f"{{id}}='{discord_id}'"
    encoded_formula = urllib.parse.quote(formula)
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}?filterByFormula={encoded_formula}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}"
    }
    
    try:
        async with http_session.get(url, headers=headers) as response:
            if response.status == 200:
                data = await response.json()
                records = data.get("records", [])
                if records:
                    return records[0].get("id"), records[0].get("fields", {})
    except Exception as e:
        print(f"Error checking Airtable for {discord_id}: {e}")
        
    return None, None


async def update_airtable_fields(discord_id: str, fields_to_update: dict):
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
        return
        
    record_id, _ = await find_airtable_record(discord_id)
    if record_id:
        url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}/{record_id}"
        headers = {
            "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}",
            "Content-Type": "application/json"
        }
        payload = {
            "fields": fields_to_update,
            "typecast": True
        }
        try:
            async with http_session.patch(url, headers=headers, json=payload) as response:
                if response.status == 200:
                    print(f"Successfully updated fields {list(fields_to_update.keys())} for {discord_id} in Airtable!")
                else:
                    text = await response.text()
                    print(f"Error updating fields {list(fields_to_update.keys())} for {discord_id}: {response.status} - {text}")
        except Exception as e:
            print(f"Exception updating fields {list(fields_to_update.keys())} for {discord_id}: {e}")

async def get_airtable_discord_id_mapping():
    """Fetches all records from Airtable and maps discord ID (string) to Airtable record ID."""
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
        return {}
        
    mapping = {}
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}"
    }
    
    offset = None
    while True:
        params = {"fields[]": "id"}
        if offset:
            params["offset"] = offset
            
        try:
            async with http_session.get(url, headers=headers, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    for record in data.get("records", []):
                        discord_id_val = record.get("fields", {}).get("id")
                        if discord_id_val:
                            mapping[str(discord_id_val)] = record["id"]
                            
                    offset = data.get("offset")
                    if not offset:
                        break
                else:
                    break
        except Exception as e:
            print(f"Error fetching Airtable records: {e}")
            break
            
    return mapping

async def batch_update_airtable_fields(updates_list):
    """
    updates_list should be a list of dicts: [{"id": record_id, "fields": {...}}, ...]
    Airtable supports up to 10 records per PATCH request.
    """
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN or not updates_list:
        return
        
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    
    # Chunk into batches of 10 maximum (Airtable limit)
    chunks = [updates_list[i:i + 10] for i in range(0, len(updates_list), 10)]
    for chunk in chunks:
        payload = {
            "records": chunk,
            "typecast": True
        }
        try:
            async with http_session.patch(url, headers=headers, json=payload) as response:
                if response.status != 200:
                    text = await response.text()
                    print(f"Error in batch update: {response.status} - {text}")
        except Exception as e:
            print(f"Exception in batch update: {e}")
        await asyncio.sleep(0.2) # Sleep slightly between chunk requests to respect API rate limits

async def sync_member_to_airtable(member, extra_fields=None):
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
        return

    record_id, fields = await find_airtable_record(str(member.id))
    
    joined_at_str = member.joined_at.isoformat() if member.joined_at else ""
    role_ids = [str(role.id) for role in member.roles if role.name != "@everyone"]
    role_names = [role.name for role in member.roles if role.name != "@everyone"]

    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }

    if record_id:
        roles_to_assign = []
        saved_role_ids = fields.get("role_ids", "")
        saved_role_names = fields.get("role_names", "")
        
        if isinstance(saved_role_ids, str):
            saved_ids_list = [r.strip() for r in saved_role_ids.split(",") if r.strip()]
        else:
            saved_ids_list = saved_role_ids or []
            
        if isinstance(saved_role_names, str):
            saved_names_list = [r.strip() for r in saved_role_names.split(",") if r.strip()]
        else:
            saved_names_list = saved_role_names or []

        for r_id in saved_ids_list:
            if r_id.isdigit():
                role = member.guild.get_role(int(r_id))
                if role and role not in roles_to_assign:
                    roles_to_assign.append(role)
                    
        for r_name in saved_names_list:
            if not any(r.name == r_name for r in roles_to_assign):
                role = discord.utils.get(member.guild.roles, name=r_name)
                if role and role not in roles_to_assign:
                    roles_to_assign.append(role)
        
        roles_to_assign = [r for r in roles_to_assign if not r.is_default() and not r.is_bot_managed()]

        if roles_to_assign:
            try:
                await member.add_roles(*roles_to_assign)
                print(f"Restored {len(roles_to_assign)} roles for returning user {member.name}.")
                all_current_roles = list(set(member.roles) | set(roles_to_assign))
                role_ids = [str(r.id) for r in all_current_roles if r.name != "@everyone"]
                role_names = [r.name for r in all_current_roles if r.name != "@everyone"]
            except Exception as e:
                print(f"Error restoring roles for {member.name}: {e}")

        patch_url = f"{url}/{record_id}"
        payload = {
            "fields": {
                "username": member.name,
                "nick": member.nick or "",
                "global_name": getattr(member, 'global_name', member.name) or "",
                "joined_at": joined_at_str,
                "role_ids": role_ids,
                "role_names": role_names,
                "left_at": None,
                **(extra_fields or {})
            },
            "typecast": True
        }
        
        try:
            async with http_session.patch(patch_url, headers=headers, json=payload) as response:
                if response.status == 200:
                    print(f"Successfully updated returning user {member.name} in Airtable!")
                else:
                    text = await response.text()
                    print(f"Error updating user {member.name}: {response.status} - {text}")
        except Exception as e:
            print(f"Exception updating user {member.name}: {e}")

    else:
        payload = {
            "records": [
                {
                    "fields": {
                        "id": str(member.id),
                        "username": member.name,
                        "nick": member.nick or "",
                        "global_name": getattr(member, 'global_name', member.name) or "",
                        "joined_at": joined_at_str,
                        "role_ids": role_ids,
                        "role_names": role_names,
                        "left_at": None,
                        **(extra_fields or {})
                    }
                }
            ],
            "typecast": True
        }
        try:
            async with http_session.post(url, headers=headers, json=payload) as response:
                if response.status in (200, 201):
                    print(f"Successfully posted new user {member.name} to Airtable!")
                else:
                    text = await response.text()
                    print(f"Error posting user {member.name}: {response.status} - {text}")
        except Exception as e:
            print(f"Exception posting user {member.name}: {e}")

@bot.event
async def on_ready():
    print(f'Ready! Logged in as {bot.user}')
    print('Listening for users joining...')
    bot.loop.create_task(startup_sync_recent_members())

async def startup_sync_recent_members():
    """Auto-sync members from the last 10 minutes just in case the bot went down."""
    now = datetime.datetime.now(datetime.UTC)
    delta = datetime.timedelta(minutes=10)
    
    await asyncio.sleep(5) # Give the gateway a moment to finish chunking and caching members
    
    for guild in bot.guilds:
        # Respect developer mode rules
        if DEVELOPER_MODE and guild.id == PAUSEAI_SERVER_ID:
            continue
        if not DEVELOPER_MODE and guild.id != PAUSEAI_SERVER_ID:
            continue
            
        print(f"Performing startup sync for {guild.name}...")
        synced_count = 0
        for member in guild.members:
            if member.joined_at and (now - member.joined_at) <= delta:
                try:
                    await sync_member_to_airtable(member)
                    synced_count += 1
                    await asyncio.sleep(0.5)
                except Exception as e:
                    print(f"Error auto-syncing {member.name}: {e}")
                    
        print(f"Startup check complete for {guild.name}: Auto-synced {synced_count} recent members.")

async def _handle_member_join(member):
    """Background task: syncs the new member immediately to Airtable."""
    await asyncio.sleep(5) # Small delay to ensure they are fully joined
    guild = member.guild
    member = guild.get_member(member.id)
    if not member:
        return
    await sync_member_to_airtable(member)

async def send_delayed_welcome_dm(member):
    """Wait temporarily after joining/screening to give the user time to settle, then send a DM."""
    await asyncio.sleep(180) # Wait 3 minutes

    guild = member.guild
    member = guild.get_member(member.id)
    if not member:
        return

    # Check which country roles they picked during the 3 minutes
    matched_countries = [role.id for role in member.roles if role.id in COUNTRY_DATA]
    
    msg_to_send = GENERAL_DM
    no_dm = False

    if matched_countries:
        country_info = COUNTRY_DATA[matched_countries[0]]
        if country_info.get("noDM"):
            no_dm = True
        elif country_info.get("msg"):
            msg_to_send = country_info["msg"]

    if not no_dm:
        try:
            await member.send(msg_to_send.format(user=member.name))
        except discord.Forbidden:
            print(f"Could not DM {member.name} - they might have DMs disabled.")

@bot.event
async def on_member_join(member):
    if DEVELOPER_MODE and member.guild.id == PAUSEAI_SERVER_ID:
        print(f"DEV MODE: Ignored {member.name} joining public server.")
        return
    if not DEVELOPER_MODE and member.guild.id != PAUSEAI_SERVER_ID:
        print(f"PROD MODE: Ignored {member.name} joining test/dev server.")
        return

    print(f"User {member.name} joined! Preparing initial Airtable sync...")
    asyncio.create_task(crm_emit("member.joined", member))
    asyncio.create_task(_handle_member_join(member))

    # If they are NOT pending (meaning no Rules Screening), send Welcome DM on a timer
    if not getattr(member, 'pending', False):
        asyncio.create_task(send_delayed_welcome_dm(member))

@bot.event
async def on_member_update(before, after):
    if DEVELOPER_MODE and after.guild.id == PAUSEAI_SERVER_ID:
        return
    if not DEVELOPER_MODE and after.guild.id != PAUSEAI_SERVER_ID:
        return

    # User just passed rules screening! Send delayed DM.
    if getattr(before, 'pending', False) and not getattr(after, 'pending', False):
        asyncio.create_task(send_delayed_welcome_dm(after))

    # Check if any new roles were added
    new_roles = [role for role in after.roles if role not in before.roles]
    added_country_roles = [role for role in new_roles if role.id in COUNTRY_DATA]
    if new_roles:
        removed_roles = [role for role in before.roles if role not in after.roles]
        asyncio.create_task(crm_emit(
            "member.roles_updated", after,
            added_role_ids=[str(r.id) for r in new_roles],
            removed_role_ids=[str(r.id) for r in removed_roles],
        ))
    
    if not added_country_roles:
        return

    # Will track if we need to set the notification flag
    onboarding_notification = False
    
    channel = bot.get_channel(int(ONBOARDING_PIPELINE_CHANNEL_ID)) if ONBOARDING_PIPELINE_CHANNEL_ID else None
    
    for role in added_country_roles:
        info = COUNTRY_DATA[role.id]
        
        # 1. Ping Staff in Onboarding Channel
        if channel and info.get("onboarders"):
            onboarder_mentions = " ".join([f"<@{uid}>" for uid in info["onboarders"]])
            ping_msg = f"{onboarder_mentions} : {after.mention} has joined from {info['name']}!"
            await channel.send(ping_msg)
            
            onboarding_notification = True
            
        # 2. Send MailerSend Email (if email exists)
        target_email = info.get("email")
        if target_email:
            url = "https://api.mailersend.com/v1/email"
            headers = {
                "Authorization": f"Bearer {MAILERSEND_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "from": {"email": "info@pauseai.info", "name": "PauseAI Info"},
                "to": [{"email": target_email, "name": f"{info['name']} Onboarder"}],
                "subject": f"{after.name} has joined PauseAI Discord",
                "text": f"A new user just joined the Discord server and received the {info['name']} role!\n\nUser: {after.name}",
                "html": f"<strong>A new user just joined the Discord server and received the {info['name']} role!</strong><br><br>User: {after.name}"
            }

            try:
                async with http_session.post(url, headers=headers, json=payload) as response:
                    if response.status in (200, 202):
                        print(f"Email sent successfully to {target_email}!")
                    else:
                        response_text = await response.text()
                        print(f"Error from MailerSend for {target_email}: {response.status} - {response_text}")
            except Exception as e:
                print(f"Error sending email to {target_email}: {e}")

    print(f"User {after.name} received country role(s)! Updating Airtable and notifying coordinators.")
    extra_fields = {"onboarding_notification": True} if onboarding_notification else None
    await sync_member_to_airtable(after, extra_fields=extra_fields)

@bot.event
async def on_member_remove(member):
    if DEVELOPER_MODE and member.guild.id == PAUSEAI_SERVER_ID:
        return
    if not DEVELOPER_MODE and member.guild.id != PAUSEAI_SERVER_ID:
        return
        
    print(f"User {member.name} left the server!")
    asyncio.create_task(crm_emit("member.left", member))
    
    if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
        return
        
    record_id, _ = await find_airtable_record(str(member.id))
    if record_id:
        url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}/{record_id}"
        headers = {
            "Authorization": f"Bearer {AIRTABLE_PERSONAL_ACCESS_TOKEN}",
            "Content-Type": "application/json"
        }
        
        left_at_str = datetime.datetime.now(datetime.UTC).isoformat()

        payload = {
            "fields": {
                "left_at": left_at_str
            },
            "typecast": True
        }

        try:
            async with http_session.patch(url, headers=headers, json=payload) as response:
                if response.status == 200:
                    print(f"Successfully marked {member.name} as left in Airtable!")
                else:
                    text = await response.text()
                    print(f"Error marking {member.name} as left: {response.status} - {text}")
        except Exception as e:
            print(f"Exception marking {member.name} as left: {e}")

@bot.tree.command(name='export_members', description="Generates a CSV export of all members.")
async def export_members(interaction: discord.Interaction):
    if not interaction.guild:
        return
    if DEVELOPER_MODE and interaction.guild.id == PAUSEAI_SERVER_ID:
        await interaction.response.send_message("❌ Cannot run in public server in Dev Mode.", ephemeral=True)
        return
    if not DEVELOPER_MODE and interaction.guild.id != PAUSEAI_SERVER_ID:
        await interaction.response.send_message("❌ Cannot run in test server in Prod Mode.", ephemeral=True)
        return

    is_admin = interaction.user.guild_permissions.administrator
    has_role = False
    if ALLOWED_EXPORT_ROLE_ID != 0:
        has_role = any(role.id == ALLOWED_EXPORT_ROLE_ID for role in interaction.user.roles)

    if not is_admin and not has_role:
        await interaction.response.send_message("❌ You must be an Administrator or have the required role to run this command.", ephemeral=True)
        return

    await interaction.response.defer()
    
    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer)
    writer.writerow(['id', 'username', 'nick', 'global_name', 'joined_at', 'role_ids', 'role_names'])
    
    for member in interaction.guild.members:
        joined_at_str = member.joined_at.isoformat() if member.joined_at else ""
        role_ids_str = ", ".join([str(role.id) for role in member.roles if role.name != "@everyone"])
        role_names_str = ", ".join([role.name for role in member.roles if role.name != "@everyone"])
        
        writer.writerow([
            str(member.id),
            member.name,
            member.nick or "",
            getattr(member, 'global_name', member.name) or "",
            joined_at_str,
            role_ids_str,
            role_names_str
        ])
        
    csv_buffer.seek(0)
    file = discord.File(fp=csv_buffer, filename="members_export.csv")
    await interaction.followup.send(content="✅ Here is the export of all members:", file=file)

@bot.tree.command(name='sync_member', description="Syncs a specific member to Airtable.")
@app_commands.describe(member="The Discord member to sync")
async def sync_member(interaction: discord.Interaction, member: discord.Member):
    if not interaction.guild:
        return

    is_admin = interaction.user.guild_permissions.administrator
    has_role = False
    if ALLOWED_EXPORT_ROLE_ID != 0:
        has_role = any(role.id == ALLOWED_EXPORT_ROLE_ID for role in interaction.user.roles)

    if not is_admin and not has_role:
        await interaction.response.send_message("❌ You must be an Administrator or have the required role to run this command.", ephemeral=True)
        return

    await interaction.response.defer()
    try:
        await sync_member_to_airtable(member)
        await interaction.followup.send(content=f"✅ Successfully synced {member.name} to Airtable!")
    except Exception as e:
        await interaction.followup.send(content=f"❌ Failed to sync {member.name}: {e}")

@bot.tree.command(name='sync_recent', description="Syncs members who joined in the last N minutes.")
@app_commands.describe(minutes="Minutes backward to check for new members")
async def sync_recent_cmd(interaction: discord.Interaction, minutes: float = 60.0):
    if not interaction.guild:
        return

    is_admin = interaction.user.guild_permissions.administrator
    has_role = False
    if ALLOWED_EXPORT_ROLE_ID != 0:
        has_role = any(role.id == ALLOWED_EXPORT_ROLE_ID for role in interaction.user.roles)

    if not is_admin and not has_role:
        await interaction.response.send_message("❌ You must be an Administrator or have the required role to run this command.", ephemeral=True)
        return

    await interaction.response.defer()
    
    now = datetime.datetime.now(datetime.UTC)
    delta = datetime.timedelta(minutes=minutes)
    
    synced_count = 0
    for m in interaction.guild.members:
        if m.joined_at and (now - m.joined_at) <= delta:
            try:
                await sync_member_to_airtable(m)
                synced_count += 1
                await asyncio.sleep(0.5)
            except Exception as e:
                print(f"Error syncing {m.name} in sync_recent: {e}")
                
    await interaction.followup.send(content=f"✅ Finished! Synced {synced_count} recent members to Airtable.")

@bot.tree.command(name='sync_old_notifications', description="Retroactively updates Airtable for old onboarding notifications")
@app_commands.describe(limit="Number of past messages to scan (default 200)")
async def sync_old_notifications_cmd(interaction: discord.Interaction, limit: int = 200):
    if not interaction.guild:
        return

    is_admin = interaction.user.guild_permissions.administrator
    has_role = False
    if ALLOWED_EXPORT_ROLE_ID != 0:
        has_role = any(role.id == ALLOWED_EXPORT_ROLE_ID for role in interaction.user.roles)

    if not is_admin and not has_role:
        await interaction.response.send_message("❌ You must be an Administrator or have the required role to run this command.", ephemeral=True)
        return

    await interaction.response.defer()
    
    channel = bot.get_channel(int(ONBOARDING_PIPELINE_CHANNEL_ID)) if ONBOARDING_PIPELINE_CHANNEL_ID else None
    if not channel:
        await interaction.followup.send(content="❌ Onboarding channel not configured or found.")
        return
        
    await interaction.followup.send(content="⏳ Scanning channel history... please wait.")    
        
    updates_needed = {}
    async for message in channel.history(limit=limit):
        if message.author.id != bot.user.id:
            continue
            
        match = re.search(r'<@!?(\d+)>\s+has joined from', message.content)
        if match:
            joined_user_id = match.group(1)
            
            extra_fields = {"onboarding_notification": True}
            
            # Check if there's any reactions
            if len(message.reactions) > 0:
                extra_fields["discord_reaction"] = True
                
            if joined_user_id not in updates_needed:
                updates_needed[joined_user_id] = extra_fields
            else:
                updates_needed[joined_user_id].update(extra_fields)
                
    if not updates_needed:
        await interaction.followup.send(content="✅ Found 0 records that needed updates.")
        return
        
    await interaction.followup.send(content=f"🔍 Found {len(updates_needed)} users needing updates. Fetching Airtable IDs...")
    
    mapping = await get_airtable_discord_id_mapping()
    
    batch_payload = []
    for discord_id, fields in updates_needed.items():
        record_id = mapping.get(discord_id)
        if record_id:
            batch_payload.append({
                "id": record_id,
                "fields": fields
            })
            
    if batch_payload:
        await interaction.followup.send(content=f"🚀 Sending {len(batch_payload)} records to Airtable using batch updates...")
        await batch_update_airtable_fields(batch_payload)
        await interaction.followup.send(content=f"✅ Finished retroactively updating {len(batch_payload)} Airtable records!")
    else:
        await interaction.followup.send(content="❌ None of the found users had records in Airtable.")

@bot.event
async def on_raw_reaction_add(payload):
    if not ONBOARDING_PIPELINE_CHANNEL_ID:
        return
        
    if payload.channel_id != int(ONBOARDING_PIPELINE_CHANNEL_ID):
        return
        
    # Ignore bot's own reactions
    if payload.user_id == bot.user.id:
        return

    channel = bot.get_channel(payload.channel_id)
    if not channel:
        return
        
    try:
        message = await channel.fetch_message(payload.message_id)
    except discord.NotFound:
        return
        
    if message.author.id != bot.user.id:
        return
        
    match = re.search(r'<@!?(\d+)>\s+has joined from', message.content)
    if match:
        joined_user_id = match.group(1)
        print(f"Reaction added to notification for user {joined_user_id}. Updating Airtable.")
        await update_airtable_fields(joined_user_id, {"discord_reaction": True})

@bot.event
async def on_message(message):
    if message.author.id == bot.user.id:
        return

    # Check developer mode restrictions to prevent conflicts during local testing
    if message.guild:
        if DEVELOPER_MODE and message.guild.id == PAUSEAI_SERVER_ID:
            return
        if not DEVELOPER_MODE and message.guild.id != PAUSEAI_SERVER_ID:
            return

    # If YAGPDB sends a message in the moderators channel, ping the moderators role in a thread (cooldown of 60s to prevent spam)
    if message.author.id == YAGPDB_USER_ID and message.channel.id == MODERATORS_CHANNEL_ID:
        global last_yagpdb_alert_time
        now = datetime.datetime.now(datetime.UTC)
        if last_yagpdb_alert_time is None or (now - last_yagpdb_alert_time).total_seconds() > 60:
            last_yagpdb_alert_time = now
            try:
                thread = await message.create_thread(name="YAGPDB Alert")
                await thread.send(f"<@&{MODERATORS_ROLE_ID}>")
            except Exception as e:
                print(f"Error creating thread or pinging moderators: {e}")

    await bot.process_commands(message)

if __name__ == "__main__":
    if not DISCORD_TOKEN or not MAILERSEND_API_KEY:
        print("Error: DISCORD_TOKEN or MAILERSEND_API_KEY is not set in the environment.")
    else:
        if not AIRTABLE_PERSONAL_ACCESS_TOKEN:
            print("Warning: Airtable variables are not fully set. The bot will skip posting to Airtable.")
        if not ONBOARDING_PIPELINE_CHANNEL_ID:
            print("Warning: ONBOARDING_PIPELINE_CHANNEL_ID is not set. The bot will not send messages in Discord.")
        bot.run(DISCORD_TOKEN)
