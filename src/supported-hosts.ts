/**
 * Which DSH release this build supports, and how that is decided.
 *
 * Two different questions hide behind "support":
 *
 * 1. **Can it be INSTALLED?** — answered by `peerDependencies`, which the package
 *    manager checks before a single line runs. Too narrow and the install is
 *    refused outright (upstream hit this: peers pinned to `0.2.1-rc.1` made
 *    `0.2.1-rc.2` uninstallable); too wide and the plugin loads onto a host it
 *    was never built against.
 * 2. **Can it WORK?** — answered at runtime by probing the services the host
 *    actually handed over, never by comparing a version string. See
 *    ./host-capabilities.
 *
 * ## Why the matrix is ONE line, not three
 *
 * An earlier revision listed `0.2.0-rc` and `0.1.7-alpha` as "structural
 * compatibility". They are not supported, and the reason is the pi-ai generation:
 *
 * | DSH line | pi-ai its `dsh-llm-pi-ai` is built against |
 * |---|---|
 * | 0.1.7-alpha | `^0.85.1` |
 * | 0.2.0-rc    | `^0.87.1` |
 * | 0.2.1-rc    | `^1.1.0`  |
 *
 * This plugin pins `dependencies: pi-ai 1.1.0` and hands model objects to the
 * host's `PiAiAdapter`. On a host whose `dsh-llm-pi-ai` was compiled against
 * 0.85 or 0.87, two generations end up in one process and the first request dies
 * with an opaque `PI_AI_ERROR` before any HTTP is sent — the failure 0.13.12
 * fixed. Advertising those lines would be selling an install that cannot serve a
 * single message, so the peer range says what is true.
 *
 * Adding a line therefore is not "append a row": it needs a build compiled and
 * run against that line's pi-ai generation.
 *
 * @module dsh-workbuddy-connect/supported-hosts
 */

/** One DSH line this build was actually run against. */
export interface SupportedHost {
  /** The line, as a reader would name it. */
  readonly line: string
  /**
   * Semver range of the `@deepseek-ai/dsh-*` packages on that line.
   *
   * Written as the range the peer declaration uses, so a reviewer can compare
   * the two by eye instead of translating between a version and a range.
   */
  readonly packages: string
  /**
   * The `@earendil-works/pi-ai` generation that line's `dsh-llm-pi-ai` was built
   * against.
   *
   * Load-bearing and easy to get wrong: a plugin compiled against one pi-ai and
   * loaded beside another fails with an opaque `PI_AI_ERROR` before any request
   * is sent, because the two copies disagree about message shapes.
   */
  readonly piAi: string
  /** What was verified, in the words of whoever verified it. */
  readonly verified: string
}

/**
 * Every host line this build supports, newest first.
 *
 * The FIRST row is the one this build's `devDependencies` compile against; the
 * others are structural compatibility, verified by the capability probes in
 * ./host-capabilities degrading rather than by a second build.
 */
export const SUPPORTED_HOSTS: readonly SupportedHost[] = [
  {
    line: '0.2.1-rc',
    packages: '^0.2.1-rc.1',
    piAi: '^1.1.0',
    verified: 'DSH Desktop 0.2.1-rc.2 (kernel and pi-ai 1.1.0): full suite, engine load, both status routes, settings writes, check-in, model switch',
  },
]


/** The oldest line still supported. */
export const SUPPORTED_MINIMUM: string = SUPPORTED_HOSTS[SUPPORTED_HOSTS.length - 1]!.packages

/** The line this build is compiled and tested against. */
export const SUPPORTED_TESTED: string = SUPPORTED_HOSTS[0]!.packages

/**
 * The one pi-ai generation this build runs on.
 *
 * Re-exported from the matrix so the guard and the manifest cannot drift from
 * what the table claims.
 */
export const SUPPORTED_PI_AI: string = SUPPORTED_HOSTS[0]!.piAi

/**
 * The full peer range, derived from {@link SUPPORTED_HOSTS}.
 *
 * Derived rather than hand-written so a new line cannot be added to the table
 * while the manifest still refuses to install on it — the failure mode upstream
 * shipped by pinning peers to a single prerelease.
 */
export const SUPPORTED_PEER_RANGE: string = SUPPORTED_HOSTS.map(host => host.packages).join(' || ')

/** The pi-ai peer range, derived the same way. */
export const SUPPORTED_PI_AI_RANGE: string = SUPPORTED_HOSTS.map(host => host.piAi).join(' || ')

/**
 * Lines this plugin deliberately does NOT support, with the reason.
 *
 * Kept as data rather than prose so the build can surface it verbatim: someone
 * who installed on the wrong kernel needs the sentence that says so, not a vague
 * "unsupported".
 */
export const UNSUPPORTED_HOSTS: readonly { line: string, reason: string }[] = [
  {
    line: '0.2.0-rc',
    reason: 'its dsh-llm-pi-ai is built against pi-ai ^0.87.1; this plugin pins 1.1.0, and two generations in one process fail every request before any HTTP is sent',
  },
  {
    line: '0.1.7-alpha',
    reason: 'its dsh-llm-pi-ai is built against pi-ai ^0.85.1 — the same generation conflict as 0.2.0-rc',
  },
]
