// Shared app-level constants used across frontend surfaces.

// APP_VERSION is generated from the root VERSION file by scripts/sync-version.mjs
// so the displayed version can never drift from the package manifests.
export { APP_VERSION } from './version';
export const APP_NAME = 'Mirabilis AI';
export const APP_CREATOR = 'Moshiko Nayman';
export const APP_FOOTER_TEXT = `${APP_NAME} by ${APP_CREATOR}`;
