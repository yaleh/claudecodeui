import { createLaunchProfilesRouter } from './launch-profiles.routes.js';
import { launchProfilesService } from './launch-profiles.service.js';

/** Launch profiles router assembled for the authenticated server mount. */
export const launchProfilesRoutes = createLaunchProfilesRouter(launchProfilesService);
