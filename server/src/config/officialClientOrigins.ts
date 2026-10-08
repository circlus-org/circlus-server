/** The hosted web client. */
export const OFFICIAL_WEB_CLIENT_ORIGIN = 'https://web.circlus.org';

/**
 * The web client bundled inside the iOS app. WKWebView serves bundled files only
 * from a custom URL scheme, and WebKit sends this Origin with the page's requests.
 * The scheme is internal to the app's web view; an Origin header is not proof of
 * the client, since any native program can send any value.
 */
export const IOS_BUNDLED_CLIENT_ORIGIN = 'org.circlus.client://app';

/** Origins every server trusts in addition to TRUSTED_CLIENT_ORIGINS. */
export const OFFICIAL_CLIENT_ORIGINS = [OFFICIAL_WEB_CLIENT_ORIGIN, IOS_BUNDLED_CLIENT_ORIGIN];
