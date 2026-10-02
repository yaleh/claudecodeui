// quayRoutes: mounted by the server entrypoint behind auth (read-only display endpoints).
// quayService: consumed by the projects module to attach Tier-1 `.quay/config.yml` detection
// to its listing without starting a subprocess.
export { quayRoutes, quayService } from './quay.module.js';
export { isReadOnlyQuayCommand } from './quay.service.js';
export type {
  QuayCommandResult,
  QuayCommandRunner,
  QuayDriverState,
  QuayDriverSummary,
  QuayProjectStatus,
  QuaySnapshot,
} from './quay.service.js';
