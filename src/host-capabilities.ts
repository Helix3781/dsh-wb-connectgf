/**
 * What the host this bundle is running on actually supports.
 *
 * The plugin talks to four optional host capabilities, and each one has shipped
 * in more than one shape across the DSH generations this peer range admits:
 *
 * | capability | 0.1.5–0.1.6 | 0.1.7 | 0.2.0 / 0.2.1 |
 * |---|---|---|---|
 * | settings write | `installSection` + `update` | `configure` + `update` | same |
 * | settings auto-form policy | `installSection` implies it | `configure({auto})` | same |
 * | `attachments` service | present | present | present |
 * | `fs.processPathFromHostPath` | n/a | present | present |
 *
 * Every probe here is STRUCTURAL — a method is looked for on the object the host
 * actually handed over, never inferred from a version string. That is deliberate
 * and it is what the upstream plugin does too (`legacy-settings.ts`): a version
 * comparison guesses, while a feature probe answers, and the answer survives a
 * backported method or a fork that moved one.
 *
 * Why a probe is not merely `'x' in service`: these members are absent from the
 * typings of the OTHER generation, so the bare check is a compile error against
 * whichever type is imported. The honest type of a value whose shape depends on
 * the host is `unknown`, so each probe starts there and narrows once.
 *
 * @module dsh-workbuddy-connect/host-capabilities
 */

/** The settings service's write half, when the host exposes one. */
export interface HostSettingsWrite {
  /** Merge editable fields into an entry's config. */
  update(entryId: string, patch: object): Promise<void>
}

/** The 0.1.7+ auto-form policy hook. */
export interface HostSettingsPolicy {
  /**
   * Declare whether the host should synthesize a configuration form.
   *
   * `auto: false` means this plugin ships its own pages. The signature differs
   * between generations (some hosts pass an owner fiber, some do not), which is
   * why the second parameter is optional here and simply forwarded.
   */
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
}

/** One host's answer, as the rest of the plugin consumes it. */
export interface HostCapabilities {
  /**
   * Which settings generation answered.
   *
   * `'forms'` — `configure`/`update` (0.1.7 and later).
   * `'none'` — no writable settings service: the store-backed preferences are
   * read-only, and the page renders no control that could not be saved.
   */
  settings: 'forms' | 'none'
  /** The write half, when {@link settings} is `'forms'`. */
  write?: HostSettingsWrite
  /** The auto-form policy hook, when the host has one. */
  policy?: HostSettingsPolicy
  /**
   * Whether the host resolves host-side file paths through `fs`.
   *
   * Used by image access: a model tool call may name a path the browser cannot
   * see, and only a host with this method can translate it. A host without it
   * degrades to "no image access", which is what the adapter already does when
   * the seam is missing.
   */
  hostPaths: boolean
}

/** Narrow one value to an object, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Probe the settings service for the write half and the policy hook.
 *
 * Both are required together: `configure` without `update` would install a form
 * whose edits this plugin could never persist, and `update` without `configure`
 * would leave the host drawing a second, competing configuration page. A
 * service with only one of them is reported as no writable settings at all, so
 * the caller degrades in exactly one place.
 *
 * @param settings - the host settings service, whose shape depends on generation.
 */
export function hostSettings(settings: unknown): Pick<HostCapabilities, 'settings' | 'write' | 'policy'> {
  const service = asRecord(settings)
  if (service === undefined) return { settings: 'none' }
  const configure = service['configure']
  const update = service['update']
  if (typeof configure !== 'function' || typeof update !== 'function') return { settings: 'none' }
  return {
    settings: 'forms',
    // Bound to the original object: these are host methods, and a detached
    // reference loses its receiver on the 0.2.x implementation.
    write: {
      update: (entryId, patch) => (update as HostSettingsWrite['update']).call(settings, entryId, patch),
    },
    policy: {
      configure: (presentation, owner) =>
        (configure as HostSettingsPolicy['configure']).call(settings, presentation, owner),
    },
  }
}

/**
 * Probe the `fs` service for the host-path translation.
 *
 * @param fs - the host filesystem service, when the profile mounts one.
 */
export function hostResolvesPaths(fs: unknown): boolean {
  const service = asRecord(fs)
  return service !== undefined && typeof service['processPathFromHostPath'] === 'function'
}

/**
 * What this host supports, from the services the caller already reached.
 *
 * The caller passes the services it has (cordis `ctx.get` returns `undefined`
 * for one the profile never mounted), and the answer is a plain record — no
 * cordis handles, no live service references beyond the bound methods — so the
 * rest of the plugin can branch on it without threading the context around.
 *
 * @param services - the services as reached, each possibly absent.
 */
export function hostCapabilities(services: { settings?: unknown, fs?: unknown }): HostCapabilities {
  return {
    ...hostSettings(services.settings),
    hostPaths: hostResolvesPaths(services.fs),
  }
}
