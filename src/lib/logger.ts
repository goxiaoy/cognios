import { attachConsole, debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

export { trace, debug, info, warn, error };

/**
 * Call once at app startup to forward plugin-log output to the browser
 * console as well (useful during development).
 */
export async function initLogger(): Promise<void> {
  await attachConsole();
}
