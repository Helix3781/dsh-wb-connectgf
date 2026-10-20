/**
 * Which DSH release this bundle supports, and how that is decided.
 *
 * The plugin has to run on more than one DSH generation, and there are two
 * different questions hiding behind "support":
 *
 * 1. **Can it be INSTALLED?** — answered by `peerDependencies`, which the
 *    package manager checks before a single line runs. Too narrow and the
 *    install is refused outright (upstream hit this: peers pinned to
 *    `0.2.1-rc.1` made `0.2.1-rc.2` uninstallable), too wide and the plugin
 *    loads onto a host it was never built against.
 * 2. **Can it WORK?** — answered at runtime by probing the services the host
 *    actually handed over, never by comparing a version string. See
 *    ./host-capabilities.
 *
 * This module owns the first question and records the answer for the second, so
 * the two can be checked against each other. The list below is the tested
 * matrix: every entry has a build this repository actually produced and ran,
 * and `SUPPORTED_MINIMUM` / `SUPPORTED_LATEST` are derived from it rather than
 * written twice.
 *
 * Adding a generation is meant to be cheap: append a row, widen the peer range,
 * run the suite. Nothing else in the plugin names a version.
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
    verified: 'DSH Desktop 0.2.1-rc.2: full suite, engine load, both status routes, settings writes',
  },
  {
    line: '0.2.0-rc',
    packages: '^0.2.0-rc.1',
    piAi: '^0.87.1',
    verified: 'structural: settings forms facade and every slot seat present; no pi-ai generation of its own is bundled',
  },
  {
    line: '0.1.7-alpha',
    packages: '^0.1.7-alpha.1',
    piAi: '^0.85.1',
    verified: 'structural: same forms facade, same slot seats; the settings page and provider cards degrade as on 0.2.x',
  },
]

/** The oldest line still supported. */
export const SUPPORTED_MINIMUM: string = SUPPORTED_HOSTS[SUPPORTED_HOSTS.length - 1]!.packages

/** The line this build is compiled and tested against. */
export const SUPPORTED_TESTED: string = SUPPORTED_HOSTS[0]!.packages

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
