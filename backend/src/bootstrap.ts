/**
 * Startup sequence for the application.
 *
 * Kept separate from `server.ts` so the ordering and fail-fast behavior can be
 * tested without opening a port or connecting to a real database.
 */
export interface BootstrapDependencies<TApp> {
  connect: () => Promise<void>;
  initializeIndexes: () => Promise<void>;
  createApp: () => TApp;
}

/**
 * Connect, initialize required model indexes, then create the Express app.
 *
 * The HTTP server must only start listening after this function resolves.
 * Errors (including index-build failures) propagate to the caller so startup
 * can fail closed instead of serving requests without required constraints.
 */
export async function bootstrapApplication<TApp>(
  dependencies: BootstrapDependencies<TApp>,
): Promise<TApp> {
  await dependencies.connect();
  await dependencies.initializeIndexes();
  return dependencies.createApp();
}
