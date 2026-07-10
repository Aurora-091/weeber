import { createGateway } from "ai";

export const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

// Model for the voice agent — low latency matters most (real-time voice
// turn-taking). Overridable per deployment via AI_GATEWAY_MODEL; any model
// the gateway serves works.
export const VOICE_AGENT_MODEL = process.env.AI_GATEWAY_MODEL || "openai/gpt-5.4-mini";
