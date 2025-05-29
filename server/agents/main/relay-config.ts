import type { ConversationRelayAttributes } from "twilio/lib/twiml/VoiceResponse.js";

export const relayConfig: Omit<ConversationRelayAttributes, "url"> = {
  ttsProvider: process.env.TTS_PROVIDER || "ElevenLabs",
  // voice: "g6xIsTj2HwM6VR4iXFCw", // jessica anne, friendly and conversational female voice, motherly
  // voice: "rCmVtv8cYU60uhlsOo1M", // ana, soft, british
  // voice: "UgBBYS2sOqTuMpoF3BR0", // mark, conversational, natural
  // voice: "HDA9tsk27wYi3uq0fPcK", // AU - Stuart - Energetic and enthusiastic
  //voice: "abRFZIdN4pvo8ZPmGxHP", // AU - Lee Middle-Aged Australian Male
  // voice: "9Ft9sm9dzvprPILZmLJl", // AU - Patrick International
  voice: process.env.TTS_VOICE || "IKne3meq5aSn9XLyUdCD", // AU - Charlie

  transcriptionProvider: process.env.ASR_TRANSCRIPTION_PROVIDER || "Deepgram",
  speechModel: process.env.ASR_SPEECH_MODEL || "nova-3-general",

  // transcriptionProvider: "google",
  // speechModel: "long",
  // transcriptionLanguage: "en-AU",
};
