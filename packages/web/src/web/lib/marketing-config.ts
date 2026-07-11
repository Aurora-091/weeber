/**
 * Marketing/waitlist page copy and data — ported verbatim from Vocalist's
 * src/config/marketing.ts (github.com/Aurora-091/Vocalist), per explicit
 * direction to use its copy where it still applies rather than
 * reinterpreting it. See DECISIONS.md for the port notes.
 */

export const SITE = {
  name: "Weeber",
  tagline: "Voice AI for SMBs",
  description:
    "Weeber answers inbound calls, recovers abandoned carts, books appointments, and routes to humans — without breaking consent regulations.",
};

export const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [];

export const FOOTER_COLUMNS = [
  {
    title: "Company",
    links: [{ label: "About", href: "/about" }],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "TCPA Compliance", href: "/terms#tcpa" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "Twitter / X", href: "https://x.com/weeberai" },
      { label: "LinkedIn", href: "https://www.linkedin.com/company/weeberai" },
      { label: "Instagram", href: "https://www.instagram.com/weeberai" },
    ],
  },
] as const;

export const STATS = [
  { value: "62%", label: "of calls to small businesses go unanswered" },
  { value: "85%", label: "of those callers never ring back — they call a competitor" },
  { value: "~70%", label: "of online carts are abandoned before checkout" },
  { value: "21×", label: "more likely to win a lead if you reply within 5 minutes" },
] as const;

export const VERTICALS = [
  {
    label: "Local & service",
    headline: "Clinics, plumbers, salons & repair shops",
    problem: "You're with a customer or closed for the night, so the phone rings out. Six of ten callers never reach you — and book the next name on Google.",
    solution: "Weeber picks up every call on the first ring, qualifies the job, books into your calendar, and texts the confirmation.",
    demoLabel: "Appointment booking",
    demoAccent: "English \u00b7 warm",
    demoDuration: "0:22",
    cta: { label: "Join the waitlist", href: "/#waitlist" },
  },
  {
    label: "D2C & e-commerce",
    headline: "Shopify, WordPress & custom stores",
    problem: "Seven of ten carts get abandoned and ad leads go cold in minutes. Every step — order, shipping, delivery, review — leaks revenue.",
    solution: "Weeber calls at every step automatically, then follows up on WhatsApp if the call's missed. Built by clicking, not coding.",
    demoLabel: "Shopify cart recovery",
    demoAccent: "English \u00b7 friendly",
    demoDuration: "0:25",
    cta: { label: "Join the waitlist", href: "/#waitlist" },
  },
  {
    label: "Enterprise",
    headline: "High-volume & regulated teams",
    problem: "Thousands of calls across locations and queues, legacy systems that don't talk, and compliance you can't bend on.",
    solution: "A voice agent built to your scripts, systems and security bar — custom integrations, audit logs, SLAs. Our engineers, not a help doc.",
    demoLabel: "Support triage",
    demoAccent: "English \u00b7 neutral",
    demoDuration: "0:21",
    cta: { label: "Talk to our team", href: "mailto:hello@weeber.ai" },
  },
] as const;

export const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Consent is verified first.",
    body: "Every number is checked against your consent records before Weeber can dial it. If consent isn't on file, the call does not happen. You cannot accidentally break the law.",
  },
  {
    step: "02",
    title: "Your agent handles the call.",
    body: "A natural-sounding voice agent follows your exact business rules — booking appointments, answering questions, recovering orders, or routing to a human when nuance is needed.",
  },
  {
    step: "03",
    title: "Every outcome is logged.",
    body: "Full transcripts, recordings, and outcome tags appear in your dashboard the moment a call ends. Every decision is auditable. Nothing falls through the cracks.",
  },
] as const;

export const PLATFORM_FEATURES = [
  {
    title: "No-code agent builder",
    body: "Configure voice, tone, and business rules — no engineers needed.",
  },
  {
    title: "Natural-sounding AI voices",
    body: "Multiple languages and voice providers, tuned to your brand.",
  },
  {
    title: "Every call in one dashboard",
    body: "Recorded and transcribed, with full audit trail.",
  },
  {
    title: "Shopify + WhatsApp sync",
    body: "Orders, carts, and messages stay connected automatically.",
  },
] as const;

export const READY_FLOWS = [
  "Abandoned cart recovery",
  "Appointment booking",
  "Order & shipping updates",
  "Review & feedback calls",
] as const;

export const UPCOMING_VERTICALS = [
  {
    title: "Hotels & hospitality",
    body: "Booking confirmations, pre-arrival concierge, and review calls.",
  },
  {
    title: "Hospitals & healthcare",
    body: "Appointment reminders, no-show recovery, and follow-ups at scale.",
  },
  {
    title: "Real estate",
    body: "Instant lead callbacks, viewings, and status updates.",
  },
  {
    title: "Logistics & delivery",
    body: "Delivery windows, failed-attempt rescheduling, and confirmations.",
  },
] as const;

export const SECURITY_FEATURES = [
  {
    title: "End-to-end encrypted",
    body: "Every call and record, in transit and at rest.",
  },
  {
    title: "Used only for your flows",
    body: "Never sold, never shared, never used to train anyone else's models.",
  },
  {
    title: "You control access",
    body: "Role-based permissions and full audit logs on every action.",
  },
] as const;

export const FAQ = [
  {
    q: "Will it actually sound human?",
    a: "Yes — natural AI voices with real back-and-forth, not a phone-tree robot. Most callers don't realize it's AI.",
  },
  {
    q: "Do I need a developer?",
    a: "No. You configure your agent with simple rules and prompts. Most setups take under an hour.",
  },
  {
    q: "Which platforms does it work with?",
    a: "Launching with Shopify and WhatsApp. WordPress, WooCommerce, and more connectors follow based on waitlist demand.",
  },
  {
    q: "What will it cost?",
    a: "The first waitlist customers lock in founder pricing for life. Full pricing is set at launch.",
  },
  {
    q: "Is my customers' data safe?",
    a: "Encrypted end to end, used only to run the flows you build, never sold or shared.",
  },
  {
    q: "When does the beta open?",
    a: "We're onboarding in small batches soon. Join the list and we'll reach out by industry.",
  },
] as const;

export const DEMOS = [
  {
    id: "cod-confirmation",
    title: "COD Confirmation",
    subtitle: "Shopify order verification in Hindi + English",
    agentName: "Amit",
    orbColor: "#E8A84C",
    audioSrc: "/audio/webber-cod-converstaion_FWQnrw94.mp3",
    transcriptOnly: false,
    transcript: [
      { pct: 3, speaker: "agent" as const, text: "Hello, my name is Amit, and I'm calling from Weeber Retail Store. Can I have two minutes of your time?" },
      { pct: 15, speaker: "customer" as const, text: "Yes." },
      { pct: 20, speaker: "agent" as const, text: "Before we begin, would you like to continue this conversation in Hindi or English?" },
      { pct: 30, speaker: "customer" as const, text: "Hindi please." },
      { pct: 36, speaker: "agent" as const, text: "\u091c\u0940, call \u0906\u092a\u0915\u0947 Cash on Delivery order \u0915\u094b confirm \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u0939\u0948, \u091c\u094b \u0906\u092a\u0928\u0947 \u0939\u093e\u0932 \u0939\u0940 \u092e\u0947\u0902 place \u0915\u0930\u0940 \u0925\u0940. \u0907\u0938\u092e\u0947\u0902 \u090f\u0915 winter cap \u0939\u0948 \u0914\u0930 \u0906\u092a\u0915\u094b delivery \u0915\u0947 time \u20b9550 \u0915\u093e payment \u0915\u0930\u0928\u093e \u0939\u094b\u0917\u093e\u0964 \u0924\u094b just to check, \u0915\u094d\u092f\u093e \u0906\u092a \u092f\u0947 delivery confirm \u0915\u0930\u0928\u093e \u091a\u093e\u0939\u0924\u0947 \u0939\u0948\u0902?" },
      { pct: 68, speaker: "customer" as const, text: "\u0939\u093e\u0902 confirm \u0915\u0930\u094b\u0964" },
      { pct: 75, speaker: "agent" as const, text: "Alright, \u092e\u0948\u0902\u0928\u0947 \u0906\u092a\u0915\u093e order confirm \u0915\u0930 \u0926\u093f\u092f\u093e \u0939\u0948, \u091c\u094b \u0915\u0940 7\u201310 \u0926\u093f\u0928\u094b\u0902 \u092e\u0947\u0902 deliver \u0939\u094b \u091c\u093e\u090f\u0917\u0940\u0964 Weeber Retail Store \u0915\u0947 customer \u092c\u0928\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f thanks. \u0905\u0917\u0930 \u0915\u094b\u0908 \u0914\u0930 help \u091a\u093e\u0939\u093f\u090f \u0924\u094b please contact \u091c\u0930\u0942\u0930 \u0915\u0930\u0947\u0902\u0964 \u0906\u092a\u0915\u093e \u0926\u093f\u0928 \u0936\u0941\u092d \u0939\u094b\u0964" },
    ],
  },
  {
    id: "cart-recovery",
    title: "Cart Recovery",
    subtitle: "Abandoned cart follow-up for Urbancart Electronics",
    agentName: "Priya",
    orbColor: "#FF6B6B",
    audioSrc: "/audio/cart_abandoned_agent.mp3",
    transcriptOnly: false,
    transcript: [
      { pct: 3, speaker: "agent" as const, text: "Hello. This is Priya talking from Urbancart. Can I have your 2 minutes of time please?" },
      { pct: 12, speaker: "customer" as const, text: "Yes." },
      { pct: 18, speaker: "agent" as const, text: "I noticed you have the SmartWave LightStrip in your cart on our website. Just wanted to share a special discount code \"Sale ten\" that gives you ten percent off on your entire order today. Would you like to complete your purchase?" },
      { pct: 38, speaker: "customer" as const, text: "Yes." },
      { pct: 44, speaker: "agent" as const, text: "Great! Also, you can use the same coupon with our BreezeGo PortableFan for more value. Should I send the cart checkout link with the coupon applied to your WhatsApp?" },
      { pct: 60, speaker: "customer" as const, text: "Yeah send the cart checkout, ok." },
      { pct: 68, speaker: "agent" as const, text: "Sure, I'll send the checkout link with the coupon applied to your WhatsApp right away. Would you like to know anything else about Urbancart products or services?" },
      { pct: 80, speaker: "customer" as const, text: "No, as of now." },
      { pct: 85, speaker: "agent" as const, text: "To summarize, I have sent the checkout link with the discount coupon to your WhatsApp. Is there anything else I can help with?" },
      { pct: 91, speaker: "customer" as const, text: "No." },
      { pct: 95, speaker: "agent" as const, text: "Thank you for choosing Urbancart Electronics. Have a wonderful day." },
    ],
  },
  {
    id: "appointment-booking",
    title: "Appointment Booking",
    subtitle: "Dental clinic rescheduling in English",
    agentName: "Sarah",
    orbColor: "#00C9A7",
    audioSrc: "",
    transcriptOnly: true,
    transcript: [
      { pct: 0, speaker: "agent" as const, text: "Good afternoon, this is Weeber calling on behalf of Bloom Dental. Am I speaking with Sarah?" },
      { pct: 11, speaker: "customer" as const, text: "Yes, this is Sarah." },
      { pct: 22, speaker: "agent" as const, text: "Hi Sarah. I'm reaching out because you have an upcoming cleaning appointment on Thursday at 2pm. I wanted to confirm you're still able to make it." },
      { pct: 33, speaker: "customer" as const, text: "Oh right, Thursday. Actually, can I move it to Friday morning?" },
      { pct: 44, speaker: "agent" as const, text: "Absolutely. I have openings at 9am and 10:30am on Friday. Which works better for you?" },
      { pct: 55, speaker: "customer" as const, text: "9am is perfect." },
      { pct: 66, speaker: "agent" as const, text: "Done. I've rescheduled you for Friday at 9am. You'll get a text confirmation in a moment. Is there anything else I can help with?" },
      { pct: 77, speaker: "customer" as const, text: "No, that's it. Thank you." },
      { pct: 88, speaker: "agent" as const, text: "You're welcome, Sarah. Have a great day." },
    ],
  },
] as const;
