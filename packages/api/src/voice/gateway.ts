import { createGateway } from "ai";

export const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

// Default model for the voice agent — chosen for low latency (important for
// real-time voice turn-taking). Swap freely; any model in the gateway works.
export const VOICE_AGENT_MODEL = "openai/gpt-5.4-mini";
