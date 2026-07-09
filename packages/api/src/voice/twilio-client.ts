import Twilio from "twilio";

export const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/** Public base URL Twilio can reach (https for webhooks, wss derived for streams). */
export function getPublicUrl() {
  const url = process.env.PUBLIC_APP_URL;
  if (!url) throw new Error("PUBLIC_APP_URL is not set — Twilio needs a public HTTPS/WSS URL");
  return url.replace(/\/$/, "");
}

export function getWsUrl() {
  return getPublicUrl().replace(/^https/, "wss").replace(/^http/, "ws");
}
