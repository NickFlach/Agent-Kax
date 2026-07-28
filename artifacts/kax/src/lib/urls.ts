/**
 * Base-path-aware URL construction.
 *
 * `vite.config.ts` refuses to boot without `BASE_PATH` and exports it as
 * `base`, so KAX explicitly supports being mounted somewhere other than `/`.
 * The router (`App.tsx`) and the player (`player-context.tsx`) honour it, but
 * the auth hook and the share-link builders hardcoded root-relative paths —
 * `fetch("/api/auth/user")`, `` `${window.location.origin}/api/share/...` ``.
 *
 * On a subpath deployment those escape the app base and hit the site root, so
 * wallet auth and session refresh break and share links point at URLs that do
 * not exist. (#110)
 *
 * Note the trailing-slash-only normalisation. `player-context.tsx` collapses
 * repeated slashes globally (`.replace(/\/+/g, "/")`), which is safe there
 * because it only ever builds a path — but the same expression applied to an
 * absolute URL would turn `https://host` into `https:/host`. `absoluteUrl`
 * exists so callers never have to think about that.
 */

/** The app's base path, without a trailing slash. `""` when mounted at root. */
export function basePath(): string {
  return (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
}

/**
 * A root-relative URL under the app base.
 *
 * @param path must start with `/` — it is appended to the base verbatim.
 */
export function appUrl(path: string): string {
  return `${basePath()}${path}`;
}

/**
 * An absolute URL under the app base, for links that leave the SPA — share
 * targets, OG/meta URLs, anything copied to a clipboard or handed to another
 * site.
 */
export function absoluteUrl(path: string): string {
  return `${window.location.origin}${appUrl(path)}`;
}
