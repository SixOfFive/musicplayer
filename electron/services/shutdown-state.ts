/**
 * Tiny shared-state module for the shutdown orchestrator.
 *
 * Exists purely to break the circular import that would otherwise form
 * between main.ts (owns the `before-quit` handler) and updater.ts
 * (needs to tell the shutdown sequence "please exit with code 42
 * instead of 0 so run.sh re-launches me"). Both modules depend on
 * this one and this one depends on neither.
 */

let shutdownExitCode = 0;

/** Called by the updater before `app.quit()` to tag the upcoming
 *  termination with a non-zero code. run.sh checks for `42` as the
 *  "wrapper, please re-spawn me" signal. */
export function setShutdownExitCode(code: number): void { shutdownExitCode = code; }

/** Read by main's before-quit handler right before it calls
 *  process.exit, so both the clean-path and watchdog-path
 *  terminate with the right code. */
export function getShutdownExitCode(): number { return shutdownExitCode; }
