/**
 * The GitHub repository that publishes SuperIU releases.
 *
 * Single source of truth: the updater queries its API and the remote VPS
 * bootstrap downloads release assets from it. These were once duplicated as
 * two separate literals and one of them drifted to a different, unrelated
 * repository — keep exactly one definition.
 */
export const REPO_SLUG = 'Kayphoon/SuperIU';
