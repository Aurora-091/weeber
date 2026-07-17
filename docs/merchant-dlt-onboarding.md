# Merchant DLT & telephony onboarding — India

For any merchant who wants to call India numbers through Weeber using their own phone number
(Exotel, Plivo, or a 1600-series number for insurance). This is a checklist for the merchant to
work through with their telecom operator/DLT platform — Weeber does not submit anything to DLT or
TRAI on your behalf today (see the honest gap note at the bottom).

**Sourced directly from TRAI's own regulation and this platform's actual code** — every rule below
is either enforced in `packages/api/src/voice/compliance/` or explicitly not yet built (marked).

## 1. Why this is required

TRAI's TCCCPR framework requires any business placing commercial/telemarketing calls in India to
dial from a number registered on the DLT (Distributed Ledger Technology) platform — not a random
SIM or unregistered virtual number. There are three series relevant to Weeber:

| Series | Use case | Who needs it |
|---|---|---|
| **140** | Promotional/telemarketing calls | Any org placing outreach calls (e.g. cart-recovery offers) |
| **160** | Transactional/service calls | Any org placing service confirmations (e.g. COD confirmation) |
| **1600** | BFSI-specific transactional/service calls | **Mandatory for the insurance vertical** — IRDAI-regulated entities, enforced in code (`checkInsuranceNumberSeriesCompliance`) |

A Shopify org typically needs 140 and/or 160 depending on which agents it runs. An insurance org
**must** have an active 1600-series number — the platform hard-blocks India dials otherwise.

## 2. Step-by-step: registering as a Principal Entity (PE) on DLT

1. **Pick a DLT platform.** Any TRAI-approved operator works — Vodafone Idea (vilpower.in),
   Airtel, Jio, BSNL/MTNL, Tata Teleservices. Vobiz (used by some competitors for 140-series) and
   Plivo (commonly used for 160-series) both route through Tata Teleservices' DLT portal.
2. **Complete Digital KYC**, uploading:
   - Certificate of Incorporation (issued by MCA/Registrar of Companies)
   - GST registration certificate
   - Company PAN card
   - Director list & Memorandum of Association (MOA)
   - A Letter of Authorization (LOA), signed by a director named in the MOA — download the sample
     LOA template from your chosen DLT portal, fill it in, get it signed before uploading.
3. **Submit the LOA** with an official mobile number and email — OTPs for verification go here
   throughout the process. These become your *permanent* registered DLT contact — choose carefully,
   they're not easily changed later.
4. **Complete payment** (typically ₹5,500-7,500 one-time, per multiple independent compliance-guide
   sources) once KYC is verified — this finalizes your PE registration and generates your **PE ID**.
5. **Register your Telemarketer (TM) chain** with your telecom access provider — links your PE ID
   to the specific number(s) you'll actually use, and generates your **TM ID**.

**Timing:** budget 3-7 business days for KYC + registration. This is the longest lead-time item in
this whole checklist — start it before anything else.

## 3. Getting the actual number

### 140-series (promotional)
Request a 140-series allocation from your telecom operator once PE/TM registration is complete —
ask specifically for "TRAI 140-series registration," not just general DLT registration.

### 160-series (transactional/service)
Same PE/TM registration, plus:
- Submit your Certificate of Incorporation + GST to your chosen telephony provider for their own
  KYC verification (separate from DLT KYC).
- Register your **Header** on the DLT portal — the sender ID/name your calls will show.
- Obtain a **URN** (Unique Reference Number) once your header is approved.
- Complete **Template registration** on DLT — the actual script/opening line your agent will speak
  needs to be registered as a template before the number goes live. **Use the exact "Conversation
  Starter" line from your agent's config in the Weeber dashboard** (the `literalGreetingTemplate`
  field, e.g. *"Hi, this is {{agent_name}} calling from {{merchant_name}}. Do you have a quick
  minute?"*) as the template text you submit.
- Once the template is approved, your number becomes active.

### 1600-series (insurance only)
Same as 160-series, but tag your entity as BFSI/insurance (IRDAI-regulated) when requesting the
allocation — this is what makes your operator issue a number from the 1600 block instead of the
general 140/160 blocks. Additionally requires an RBI/SEBI certificate as proof of regulatory
compliance during Header registration.

**Deadline note:** TRAI's original 1600-series compliance deadline was February 15, 2026 — already
passed as of this writing. If you don't have PE/DLT registration in progress for insurance calling,
start immediately.

## 4. What to share with Weeber, and where it goes

| What | Where it goes in the platform | Why |
|---|---|---|
| Your registered phone number | Dashboard → Numbers page | So calls actually dial from it |
| The number's series (140/160/1600) | Dashboard → Numbers page, "series" dropdown next to the number | Feeds `orgPhoneNumbers.numberSeries` — this is the field the compliance gate actually checks |
| Your Twilio/Plivo/Exotel account credentials | Dashboard → Settings → Telephony (BYO credentials form) | Validated live against that provider's own Account API before being stored — see §5 |
| For insurance orgs: your licensed advisors' names + licensed states | Dashboard → Settings → Compliance → Licensed advisors | Feeds `checkInsuranceProducerLicensing` — blocks a transfer/booking to a US state with no licensed advisor on file |

**We do not need your PE ID or TM ID directly** — those live with your telecom operator/DLT
platform, not in this platform's schema today (see the gap note below). What we need is simply:
the number itself, and which series it's registered under, so our own gate can verify it.

## 5. Connecting your telephony credentials — checklist

**Twilio:** platform-managed — contact Weeber to provision a sub-account, no BYO credentials needed.

**Plivo (BYO):**
1. Get your Auth ID + Auth Token from your Plivo console.
2. Enter them in Dashboard → Settings → Telephony, along with the phone number.
3. These are validated live against Plivo's own Account API (`GET /v1/Account/{authId}/`, checking
   the account is `ACTIVE`) before anything is saved — an invalid credential is rejected
   immediately, not silently stored.
4. If this is an *inbound* number (calls arrive at your existing Plivo number), your Plivo
   Application's Answer URL must include `?orgId=<your org id>` — ask Weeber support for your
   exact org ID and Answer URL to paste into your Plivo Application config.

**Exotel (BYO):**
1. Get your SID, API Key, and API Token from your Exotel console.
2. Enter them in Dashboard → Settings → Telephony, along with your account's subdomain (e.g.
   `api.exotel.com` or `api.in1.exotel.com` — region-specific, check your Exotel account settings).
3. **If this is an inbound number**, your Exotel Voicebot Applet's WSS URL must be set to:
   `wss://<your-org-id>:<your-exotel-api-token>@<weeber-domain>/api/voice/stream/exotel`
   — Exotel embeds these as HTTP Basic Auth credentials on connect (their own documented behavior,
   not a Weeber-specific requirement), and Weeber verifies them against your stored API token
   before accepting the connection. Ask Weeber support for the exact domain to use.
4. For outbound calls Weeber places on your behalf, this URL is constructed and authenticated
   automatically — no action needed from you.

## 6. Honest gaps — what Weeber does *not* do for you today

Unlike some competitors (Bolna, for example, actively coordinates PE-TM ID verification with
Plivo/TATA Teleservices and reviews an in-app compliance-document submission before letting a
merchant purchase a number), **Weeber's role in this process today is entirely passive**:

- We do not submit any documents to DLT, TRAI, or your telecom operator on your behalf.
- We do not track your PE ID or TM ID anywhere in our system.
- We do not have an in-app compliance-document upload/review flow.
- The only thing the platform actively enforces is: (a) for insurance orgs, a hard block on India
  dials unless a 1600-series number is on file, and (b) an **opt-in** general check (off by
  default — ask Weeber support to enable it for your org) that blocks India dials for any vertical
  if no 140/160/1600-series number is registered at all.

This checklist exists so you can run the DLT registration process correctly yourself. If you want
Weeber to take a more active role (document collection, operator coordination), that's a real
product gap worth raising with your Weeber contact — it isn't built yet.
