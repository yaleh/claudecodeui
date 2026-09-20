// Consumed by the websocket module's chat gateway to lock a session to its first launch profile.
export { resolveSessionProfileLock } from './session-profile-lock.js';
export type { SessionProfileLockDecision } from './session-profile-lock.js';
// Consumed by the providers module (Claude SDK runtime) and the websocket
// module (shell pty) to compile the env overlay for a launch.
export { resolveLaunchSpec } from './launch-profiles.service.js';
// Consumed by the providers module (Claude SDK runtime) to compile the spawn env for the selected custom model.
export { resolveModelLaunchSpec, resolveModelContextWindowRow } from './model-launch-spec.service.js';
export { launchProfilesService } from '@/modules/launch-profiles/launch-profiles.service.js';
export { isAllowedLaunchEnvKey, resolveContextWindow } from '@/modules/launch-profiles/launch-spec.service.js';
// Consumed by the server entrypoint to mount the protected launch-profiles CRUD endpoints.
export { launchProfilesRoutes } from './launch-profiles.module.js';
