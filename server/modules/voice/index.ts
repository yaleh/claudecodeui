// voiceRoutes: used by the server entrypoint to mount authenticated STT/TTS endpoints.
export { voiceRoutes } from './voice.module.js';
// voiceLexicon: the U-source lexicon singleton. Used by the chat dispatch to
// record the identifier-shaped tokens of every message a user sends — the
// auto-record half of the cold-start-plus-live pair — and by the Voice routes.
export { voiceLexicon } from './voice-lexicon.js';
export type { VoiceLexiconDependencies } from './voice-lexicon.js';
