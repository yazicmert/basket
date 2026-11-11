/**
 * Section 7.2 — Future Live Monitoring Interfaces
 *
 * Defines non-invasive, consent-gated interfaces for future event monitoring
 * without requiring privileged kernel extensions or invasive hooks.
 *
 * Accounts for the fundamental OS reality that raw filesystem notifications (e.g., FSEvents)
 * report mutated paths after the fact and do NOT reliably identify the responsible PID or
 * AI conversation session unless correlated with active session transcript appends.
 */

export const LiveSignalType = Object.freeze({
  FILESYSTEM_CHANGE: 'FILESYSTEM_CHANGE',
  PROCESS_LIFECYCLE: 'PROCESS_LIFECYCLE',
  SESSION_LIFECYCLE: 'SESSION_LIFECYCLE',
  TOOL_INVOCATION: 'TOOL_INVOCATION',
  COMMAND_EXECUTION: 'COMMAND_EXECUTION',
  GIT_WORKTREE_DELTA: 'GIT_WORKTREE_DELTA'
});

export class LiveMonitorProvider {
  constructor(consentPolicy = { enabled: false, authorizedRoots: [] }) {
    this.consentPolicy = {
      enabled: Boolean(consentPolicy.enabled),
      authorizedRoots: Array.isArray(consentPolicy.authorizedRoots)
        ? consentPolicy.authorizedRoots
        : [],
      allowProcessInspection: Boolean(consentPolicy.allowProcessInspection),
      allowSessionLogTailing: Boolean(consentPolicy.allowSessionLogTailing)
    };
    this.listeners = new Set();
    this.active = false;
  }

  /**
   * Starts opt-in monitoring if explicit user consent is granted.
   */
  async start() {
    if (!this.consentPolicy.enabled) {
      return {
        started: false,
        reason: 'EXPLICIT_USER_CONSENT_REQUIRED'
      };
    }
    this.active = true;
    return {
      started: true,
      monitoredRoots: this.consentPolicy.authorizedRoots
    };
  }

  async stop() {
    this.active = false;
    return { stopped: true };
  }

  onSignal(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Evaluates whether a live signal provides VERIFIED or only INFERRED provenance.
   * Filesystem events alone never qualify as VERIFIED conversation provenance.
   */
  evaluateSignalConfidence(signal) {
    if (signal.type === LiveSignalType.TOOL_INVOCATION && signal.sessionId && signal.targetPath) {
      return 'VERIFIED';
    }
    if (signal.type === LiveSignalType.FILESYSTEM_CHANGE) {
      // OS filesystem events alone do not prove which conversation or process wrote the file
      return 'UNKNOWN';
    }
    return 'INFERRED';
  }
}
