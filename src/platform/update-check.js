/**
 * Checks whether a newer release of Artifact Atlas exists.
 *
 * This is the only network request the app makes. It asks GitHub for the latest release of
 * the project and compares version numbers. Nothing about the user, their Mac or their files
 * is sent: the request carries no body and no identifier beyond the app's own version in the
 * User-Agent header. The check can be turned off in Settings. Nothing is downloaded or
 * installed; the app only tells the user that a newer version exists.
 */

export const RELEASES_API_URL = 'https://api.github.com/repos/yazicmert/basket/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/yazicmert/basket/releases/latest';
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

/** Parses "v1.2.3" or "1.2.3" into [1, 2, 3]; returns null for anything else. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when a is older than b, zero when equal, positive when newer. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/**
 * Asks for the latest release. Never throws: a failed or offline check reports
 * `updateAvailable: false` with an `error` code.
 */
export async function checkForUpdate({ currentVersion, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const result = {
    currentVersion: currentVersion || null,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: RELEASES_PAGE_URL,
    checkedAt: new Date(now()).toISOString(),
    error: null
  };
  if (!parseVersion(currentVersion)) {
    return { ...result, error: 'UNKNOWN_CURRENT_VERSION' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ...result, error: 'FETCH_UNAVAILABLE' };
  }
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `ArtifactAtlas/${currentVersion}`
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { ...result, error: `HTTP_${response.status}` };
    }
    const release = await response.json();
    // Drafts and pre-releases are not offered as updates
    if (!release || release.draft || release.prerelease || !parseVersion(release.tag_name)) {
      return { ...result, error: 'NO_USABLE_RELEASE' };
    }
    const latest = parseVersion(release.tag_name).join('.');
    return {
      ...result,
      latestVersion: latest,
      updateAvailable: compareVersions(latest, currentVersion) > 0
    };
  } catch (err) {
    return { ...result, error: err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}
