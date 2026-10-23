/**
 * The WorkBuddy settings page: every pooled account, for both products, their
 * meters, their model lists, and the filter over each one.
 *
 * Why this is a settings *page* rather than a card in the Plugins tab: the two
 * products together are a resource the user checks and acts on — add an
 * account, see what is left, delete one that lapsed — and that is a destination,
 * not a footnote under a plugin list. The Plugins tab keeps the plugin's own
 * card; this page is where the accounts live.
 *
 * Layout, ported from the reference implementation's settings page
 * (`dsh-commandcode-provider`, whose `section.tsx` this page follows component
 * for component):
 *
 *   [accounts heading]                             [+ Add account]
 *   [account rows: state, ⋮ menu, balance meter, disclosure]
 *   [per-product total credit tiles]
 *   [<product> · Models]                            [Refresh]
 *   [filter row: model picker + switch] [row per model: window, detection]
 *   [sticky save bar, while the model filters are staged]
 *
 * What is WorkBuddy's rather than the reference's, and why:
 *
 * - **two products on one page.** The reference has one provider; here the two
 *   rosters stay separate all the way down — separate pools, separate totals,
 *   separate filters — because a sum across them would be a number that
 *   describes nothing (the credits are not convertible and the accounts are not
 *   interchangeable).
 * - **immediate writes where the reference stages.** Account actions (enable,
 *   test, remove, rename) and per-model detection/context writes go out at once:
 *   they are imperative ("stop using this account now", "probe this model now"),
 *   and staging an imperative behind a save button is how a user ends up staring
 *   at a page that has not done what they asked. The MODEL FILTER is staged, as
 *   the reference stages it — assembling "only these models" is a multi-step
 *   edit whose intermediate states are not decisions.
 * - **a picker trigger that states what the filter applies**, not what the
 *   calendar holds: with the filter off the menu edits the whole catalog (there
 *   is no stored list), while the row must not claim a selection that nothing is
 *   filtering.
 *
 * @module dsh-workbuddy-connect/client/settings-page
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { describeWait } from '../status-paths.ts'
import { isWorkBuddySidebarCreditStyle } from '../status-paths.ts'
import type { WorkBuddySidebarCreditStyle } from '../status-paths.ts'
import type {
  WorkBuddyAccountAction,
  WorkBuddyAccountResult,
  WorkBuddyQrChallenge,
  WorkBuddyWebAccount,
  WorkBuddyWebCheckinRow,
  WorkBuddyWebModelBadge,
  WorkBuddyWebProbeSection,
  WorkBuddyWebStatus,
} from '../status-paths.ts'
import { encodeQrCode } from './qr-code.ts'
import { CARD_VARIANTS } from './card-variants.ts'
import { isWorkBuddyWebStatus, readWorkBuddyStatus, statedPreference } from './status-document.ts'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { openExternalLink } from './open-external.ts'
import type { WorkBuddyExternalOpenOptions } from './open-external.ts'
import { ModelPicker, selectableModels } from './model-picker.tsx'
import { accountSummaryMeta, accountSummaryState, formatCredit, shortTokens } from './account-summary.ts'
import type { AccountSummaryCopy } from './account-summary.ts'
import { ActionButton } from './ui-button.tsx'
import {
  Badge,
  Fact,
  FilterRow,
  SegmentedField,
  SettingRow,
  SettingsGroup,
  StatusDot,
  ToggleField,
  cx,
} from './ui-rows.tsx'
import type { WorkBuddyCardVariant } from './card-variants.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Copy function injected by the client registration. */
type Translate = (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
/**
 * Bind one surface's dictionary to the shared account-summary words.
 *
 * The summary module owns WHICH facts a row states and in what order; the
 * dictionary owns how each is worded. This is the one place the two meet, so a
 * second surface reuses the same facts without copying the formatting.
 */
function accountSummaryCopy(t: Translate): AccountSummaryCopy {
  return {
    disabled: t('accountStateDisabled'),
    sessionDead: t('accountStateSessionDead'),
    exhausted: t('accountStateExhausted'),
    limited: t('accountStateLimited'),
    expired: t('accountExpired'),
    creditsFailed: t('accountCreditsFailed'),
    creditsPending: t('accountCreditsPending'),
    remainingOf: ({ remaining, total }) => t('accountMetaRemainingOf', { remaining, total }),
    remaining: ({ remaining }) => t('accountMetaRemaining', { remaining }),
    used: ({ used }) => t('accountMetaUsed', { used }),
    requests: ({ count }) => t('accountMetaRequests', { count }),
    inputTokens: ({ value }) => t('accountMetaInputTokens', { value }),
    outputTokens: ({ value }) => t('accountMetaOutputTokens', { value }),
    cache: ({ percent }) => t('accountMetaCache', { percent }),
    resets: ({ when }) => t('accountMetaResets', { when }),
    tokenExpires: ({ when }) => t('accountMetaTokenExpires', { when }),
    wait: ({ value, unit }) => t(unit === 'hour' ? 'waitHours' : 'waitMinutes', { value }),
  }
}

/** How often a QR challenge is checked. */
const POLL_INTERVAL_MS = 2_000
/** How often the page re-reads both products while it is open. */
const REFRESH_INTERVAL_MS = 60_000

/**
 * Where the last answered status documents are cached, per product.
 *
 * The same mechanism the reference implementation this page follows
 * (`@mars-sea/dsh-commandcode-provider`) uses for its own cross-session cache:
 * a namespaced `localStorage` key, read and written through a store that
 * tolerates a missing or throwing storage (private modes, a WebView without one)
 * by yielding nothing and dropping the write.
 *
 * Why the cache exists at all: this page's first paint is a read of the status
 * route, and that route answers only after it has looked up every account's
 * credit against the upstream. On a slow link that is seconds of blank page for
 * figures the browser already had. Cached documents paint immediately, and the
 * live read replaces them when it lands — the same stale-while-revalidate shape,
 * with the screen never showing LESS than it already knew.
 *
 * What is deliberately NOT cached: nothing beyond what the status route already
 * sends to this same origin (no token material — the route never carries any),
 * and nothing that outlives the account it describes. A cache entry is keyed by
 * product and replaced wholesale on every successful read; a stale entry is only
 * ever a starting point, never a value that survives a failed read.
 */
const STATUS_CACHE_PREFIX = 'dsh-wb-connectgf/status'

/** The cache key for one product's document. */
function statusCacheKey(variantId: string): string {
  return `${STATUS_CACHE_PREFIX}/${variantId}`
}

/**
 * Whether a cached document's `probe.results` entries are all renderable.
 *
 * {@link isWorkBuddyWebStatus} checks only the discriminator, so a stored
 * document can carry a result row whose `efforts` is missing — a shape the
 * renderer dereferences (`result.efforts.length`). The live route cannot
 * produce one (the host's store validates every row it reads), but this cache
 * is shared `localStorage`: a document written by an older build, or by any
 * other client on this origin, is not covered by that guarantee and would crash
 * the first paint, before the live read has any chance to replace it.
 *
 * A row that fails this check drops the WHOLE document rather than the row:
 * the document is a single answer, and keeping a partially-trusted one would
 * let the rest of it be read as though the missing row had never been there.
 */
export function hasRenderableProbeResults(status: WorkBuddyWebStatus): boolean {
  if (status.status !== 'signed-in') return true
  const results = status.probe?.results
  if (results === undefined) return true
  return Array.isArray(results) && results.every(result =>
    result !== null && typeof result === 'object' && Array.isArray(result.efforts))
}

/** Read one cached document, or `undefined` when there is none to trust. */
function readCachedStatus(variantId: string): WorkBuddyWebStatus | undefined {
  try {
    const raw = localStorage.getItem(statusCacheKey(variantId))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!isWorkBuddyWebStatus(parsed)) return undefined
    return hasRenderableProbeResults(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Remember one document for the next visit; a failed write is simply dropped. */
function writeCachedStatus(variantId: string, status: WorkBuddyWebStatus): void {
  try {
    localStorage.setItem(statusCacheKey(variantId), JSON.stringify(status))
  } catch {
    // A full or unavailable storage is not a reason to fail the read that
    // just succeeded: the page has its answer, and the next visit simply
    // reads it live again.
  }
}

/* ---------------------------------------------------------------- pieces */

/**
 * Paint a QR symbol into a canvas.
 *
 * An integer number of device pixels per module: a fractional scale softens the
 * module edges, which is the one thing that makes a camera struggle to lock on.
 */
function QrCanvas({ text, modulePixels }: { text: string, modulePixels: number }): React.ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    let code
    try {
      code = encodeQrCode(text)
    } catch {
      // A payload past the encoder's capacity is reported by the caller; the
      // canvas simply stays blank rather than throwing out of render.
      return
    }
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const moduleSize = Math.max(1, Math.floor((modulePixels * ratio) / code.size))
    const side = moduleSize * code.size
    canvas.width = side
    canvas.height = side
    canvas.style.width = `${String(Math.round(side / ratio))}px`
    canvas.style.height = `${String(Math.round(side / ratio))}px`
    const context = canvas.getContext('2d')
    if (context === null) return
    context.fillStyle = '#fff'
    context.fillRect(0, 0, side, side)
    context.fillStyle = '#000'
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        if (code.modules[y * code.size + x] !== true) continue
        context.fillRect(x * moduleSize, y * moduleSize, moduleSize, moduleSize)
      }
    }
  }, [text, modulePixels])
  return <canvas ref={ref} role="img" aria-label="QR" style={{ display: 'block' }} />
}
/**
 * One pooled account, as one row inside its product's card.
 *
 * The row is deliberately flat: a status dot, the account's name, and ONE grey
 * line of small text under it carrying the facts a reader checks at a glance —
 * what is left, what this cycle consumed, what this plugin has sent through the
 * account, and when the allowance returns. There is no disclosure: every figure
 * used to sit behind a chevron, which turned a page about balances into a list
 * of names with the balances hidden. Anything that is a DECISION (enable, test,
 * rename, remove) lives in the ⋮ menu instead, so nothing in the row has to be
 * expanded to be acted on.
 *
 * The meta line omits what is unknown rather than printing a zero: "the
 * upstream did not report this" and "this is zero" are different answers, and
 * the second one is the kind of wrong-but-plausible figure a reader acts on.
 */
function AccountRow({ account, busy, now, t, onAction }: {
  account: WorkBuddyWebAccount
  busy: boolean
  now: number
  t: Translate
  onAction: (action: WorkBuddyAccountAction) => void
}): React.ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  /** The inline editor this row has open, if any. */
  const [mode, setMode] = useState<'rename' | 'remove' | undefined>(undefined)
  const [label, setLabel] = useState('')
  const copy = accountSummaryCopy(t)
  const { tone, text: stateLabel } = accountSummaryState(account, now, copy)

  const items: MenuEntry[] = [
    {
      id: 'toggle',
      label: account.enabled === true ? t('accountDisable') : t('accountEnable'),
      disabled: busy,
    },
    { id: 'test', label: t('accountTest'), disabled: busy },
    { type: 'separator', id: 'sep-edit' },
    { id: 'rename', label: t('accountRename'), disabled: busy },
    { type: 'separator', id: 'sep-danger' },
    // Destructive: the stored sign-in goes with it, and restoring the account
    // means signing in again. `danger` makes the row error-coloured before its
    // text is read.
    { id: 'remove', label: t('accountRemoveAction'), disabled: busy, danger: true },
  ]
  const onMenuSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'toggle') onAction({ action: 'enable', id: account.id, enabled: account.enabled !== true })
    else if (id === 'test') onAction({ action: 'test', id: account.id })
    else if (id === 'rename') {
      setLabel(account.name)
      setMode('rename')
    } else if (id === 'remove') setMode('remove')
  }

  return (
    <div className={cx('wbp-accountRow', account.enabled === true && tone === 'ok' && 'wbp-accountRowActive')}>
      <div className="wbp-accountHead">
        <StatusDot tone={tone} title={stateLabel} />
        <span className="wbp-accountName" title={account.name}>{account.name}</span>
        {tone === 'ok' ? null : <span className="wbp-usagePlanStatus">{stateLabel}</span>}
        <span className="wbp-spacer" />
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          onSelect={onMenuSelect}
          items={items}
          align="end"
          portal
          anchor={
            <button
              type="button"
              className="wbp-iconButton"
              aria-label={ `${account.name} — ${t('accountActions')}` }
              title={t('accountActions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(value => !value) }}
            >
              <span className="wbp-kebab" aria-hidden="true" />
            </button>
          }
        />
      </div>

      {/*
        * The grey line under the name: one string built from the pieces that are
        * actually known, so a row with no balance still states its requests and
        * its reset instead of rendering an empty second line.
        */}
      <p className="wbp-accountMeta">{accountSummaryMeta(account, now, copy)}</p>

      {mode !== 'rename' ? null : (
        <div className="wbp-inlineForm">
          <div className="wbp-fieldHead">
            <span className="wbp-label">{t('accountRename')}</span>
          </div>
          <div className="wbp-inlineActions">
            <input
              className="wbp-input"
              value={label}
              placeholder={t('accountRenamePlaceholder')}
              aria-label={t('accountRename')}
              disabled={busy}
              autoFocus
              onChange={event => { setLabel(event.target.value) }}
            />
            <span className="wbp-spacer" />
            <ActionButton label={t('cancel')} onClick={() => { setMode(undefined) }} />
            <ActionButton
              label={t('accountApply')}
              tone="primary"
              disabled={busy || label.trim() === ''}
              onClick={() => { onAction({ action: 'label', id: account.id, label: label.trim() }); setMode(undefined) }}
            />
          </div>
        </div>
      )}

      {mode !== 'remove' ? null : (
        <div className="wbp-confirmBar">
          <p className="wbp-confirmText">{t('accountRemoveConfirm', { name: account.name })}</p>
          <div className="wbp-dialogActions">
            <ActionButton label={t('cancel')} onClick={() => { setMode(undefined) }} />
            <ActionButton
              label={t('accountRemove')}
              tone="danger"
              disabled={busy}
              onClick={() => { onAction({ action: 'remove', id: account.id }); setMode(undefined) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
/**
 * The promotional chips one model row shows, without saying "free" twice.
 *
 * The upstream's own badge text is shown verbatim rather than translated — it is
 * the product's own wording for its own promotion ("Free now", "限时免费"), and
 * restating it in this plugin's language would be inventing copy for a claim the
 * upstream made.
 *
 * The deduplication exists because a free model can arrive with *both* facts: a
 * badge naming the promotion, and the `free` flag the rate was derived from. The
 * international catalog does exactly that, which rendered "Free now" and "Free"
 * side by side. When a badge already says the model is free, the derived chip is
 * dropped — the badge is the specific claim, and this one is only the summary.
 */
function promotionChips(model: WorkBuddyWebModelBadge, freeLabel: string): string[] {
  const badges = model.badges ?? []
  // Covers both products' wording: the international catalog says "Free now",
  // the CN one says "限时免费", and either already carries the claim.
  const alreadySaysFree = badges.some(badge => /free/i.test(badge) || badge.includes('免费'))
  return [
    ...badges,
    ...model.free === true && !alreadySaysFree ? [freeLabel] : [],
  ]
}
/**
 * The model list for one product: a context-length switch where the upstream
 * declares a choice, and a reasoning-level detection button where the model has
 * levels worth discovering.
 *
 * Both controls are writes and share the key-bearing route the account actions
 * use. Detection sits here rather than only in the composer because it is a
 * property of the model you are looking at — reading down the list with the
 * models in front of you is the moment you notice one has no levels declared,
 * and having to go and pick that model first to fix it was the roundabout part.
 */
function ModelsBlock({ variant, status, probe, busy, t, staged, context, onContext, onRefresh, onDetect, onClearProbe, onStage }: {
  variant: WorkBuddyCardVariant
  status: WorkBuddyWebStatus | undefined
  /** Detection state, from the status document: consent, candidates, results. */
  probe: WorkBuddyWebProbeSection | undefined
  busy: boolean
  t: Translate
  /** Ambient seams for a sign-in hand-off; see {@link openExternalLink}. */
  context: WorkBuddyExternalOpenOptions['context']
  /** This product's uncommitted model selection; see {@link ModelsPageEdit}. */
  staged: { filterOn: boolean, allowlist: readonly string[] } | undefined
  onContext: (model: string, length: number) => void
  onRefresh: () => void
  onDetect: (model: string) => void
  onClearProbe: () => void
  /** Stage one product's model filter; `undefined` stages a discard. */
  onStage: (next: { filterOn: boolean, allowlist: readonly string[] } | undefined) => void
}): React.ReactNode {
  const signedIn = status !== undefined && status.status === 'signed-in' ? status : undefined
  const models = signedIn?.models ?? []
  const catalog = signedIn?.catalog
  /**
   * The account bucket the model filter belongs to; undefined renders no
   * filter row at all.
   *
   * Absent for an account with no stable user id: the preference is keyed by
   * `uid:enterpriseId`, so there is no bucket to store it in, and a control
   * that cannot be saved is worse than one that is not offered.
   */
  const visibility = signedIn?.visibility
  /**
   * The selection in force for this product: the staged draft when one exists,
   * else what the host reports.
   *
   * The draft is absolute rather than a patch — `allowlist.length === 0` IS the
   * "no filter" state — so there is exactly one source of truth per render and
   * no precedence puzzle between two lists that could disagree.
   */
  const filterOn = staged !== undefined ? staged.filterOn : visibility?.allowlist !== undefined
  /**
   * The selection the picker reads and writes.
   *
   * With the filter ON it is the staged draft or the host's list. With it OFF
   * the host keeps no list — "off" and "everything visible" are the same state —
   * so the menu edits a calendar of the whole catalog, and the first untick
   * there turns the filter on (see the picker's commit below). That is what
   * keeps the menu usable without flipping the switch first, and what stops an
   * untick from hiding the entire catalog through a list that only ever named
   * the one model.
   *
   * The CALENDAR is read-only for the trigger's label ({@link displayed}): while
   * the filter is off nothing is filtered, and a label counting the whole
   * catalog would read as a filter that is on.
   */
  const pickerSelection = staged !== undefined
    ? staged.allowlist
    : visibility?.allowlist ?? (filterOn ? [] : models.map(model => model.id))
  /**
   * What the FILTER is currently about, which is what the row's label states.
   *
   * Off is "everything", so the label says nothing about models rather than
   * counting them; on names the count the filter is actually applying.
   */
  const displayed = filterOn ? pickerSelection : visibility?.allowlist ?? []
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })
  /**
   * Which model is waiting for the user to agree to a detection.
   *
   * Detection sends real requests against the user's own quota, so it asks
   * first — inline, in the row the button belongs to, rather than in a modal:
   * the question is one line about the model beside it, and a dialog for that is
   * heavier than the action it guards.
   */
  const [pending, setPending] = useState<string>()
  // A re-read can drop a model from the candidates; a stale confirmation for a
  // row that no longer renders would hang around invisibly.
  useEffect(() => {
    if (pending !== undefined && !(probe?.candidates ?? []).includes(pending)) setPending(undefined)
  }, [pending, probe?.candidates])
  const catalogNote = catalog === undefined
    ? undefined
    : <span className="wbp-hint">
        {catalog.source === 'live' && catalog.fetchedAt !== undefined
          ? t('modelsSourceLive', { time: format.format(new Date(catalog.fetchedAt)) })
          : catalog.source === 'saved' && catalog.fetchedAt !== undefined
            ? t('modelsSourceSaved', { time: format.format(new Date(catalog.fetchedAt)) })
            : t('modelsSourceFallback')}
      </span>
  // This block draws ROWS only. The heading, the product switch and the Refresh
  // button belong to `ModelsSection`, which wraps it: one group is shown at a
  // time, and a second heading inside would stack two titles over one list.
  return (
    <>
      {catalogNote === undefined ? null : (
        <div className="wbp-row wbp-rowFlush">
          <div className="wbp-rowText">{catalogNote}</div>
        </div>
      )}
      {/*
        * The filter row: a switch plus the model picker, above the list they
        * govern.
        *
        * The two controls answer the two halves of one decision, which is why
        * they share a row rather than each owning one:
        *
        * - the PICKER says which models the filter is about. It is a searchable
        *   checkbox menu rather than a checkbox column beside the list, so the
        *   models a product offers and the models it ships to DSH are two
        *   different lists: every catalog model keeps its row below (context
        *   window, detection, promotions), while the filter is edited in one
        *   place regardless of how long the catalog grows;
        * - the SWITCH decides whether that selection reaches the model picker at
        *   all. Off shows everything, which is the state a fresh account is in.
        *
        * Both are STAGED (see {@link ModelsPageEdit}): nothing is written until
        * the page's save bar is used, so a filter the user is still assembling
        * never half-lands on the host.
        *
        * Turning the switch on needs a selection to apply, and the whole catalog
        * is the seed only when nothing is selected at all — "only show what I
        * pick" starting from nothing picked would be a picker with no models in
        * it, and the user's next move (unticking the few they do not want) is
        * the same either way. Turning it off stages the clear while keeping the
        * selection, so flipping it back on restores exactly what was there.
        *
        * Absent entirely when the document carries no visibility section: an
        * account with no stable uid has no bucket to key the preference by.
        */}
      {models.length === 0 || visibility === undefined ? null : (
        <FilterRow
          id={`wbp-filter-${variant.id}`}
          enabled={filterOn}
          disabled={busy}
          label={t('filterModelsLabel')}
          description={filterOn ? t('filterModelsHint') : t('filterModelsIdle')}
          summary={t('filterModelsCount', { ticked: displayed.length, total: models.length })}
          clearLabel={t('filterModelsClear')}
          onToggle={next => {
            const ids = pickerSelection.length > 0 ? pickerSelection : models.map(model => model.id)
            onStage({ filterOn: next, allowlist: ids })
          }}
          onClear={() => { onStage({ filterOn: false, allowlist: displayed }) }}
          control={
            <ModelPicker
              id={`wbp-filter-models-${variant.id}`}
              // The menu's ticks follow the calendar (the whole catalog while the
              // filter is off, which is what makes the first pick possible); the
              // trigger's label states what the FILTER is about, so an off row
              // names no count instead of one the picker is not applying.
              selected={pickerSelection}
              labelled={displayed}
              catalog={selectableModels(models)}
              disabled={busy}
              label={t('filterModelsLabel')}
              t={t}
              // Picking is a statement about which models to keep, so it turns
              // the filter on: the alternative — staging a list while the
              // switch stays off — is a choice the picker would not honour, and
              // the user would have to find the switch to find out.
              onPick={ids => { onStage({ filterOn: true, allowlist: ids }) }}
            />
          }
        />
      )}
      {signedIn === undefined && status?.status === 'error' ? (
        <p className="wbp-rowError" role="status">{status.message}</p>
      ) : null}
      {models.length === 0
        ? <SettingRow title={<span className="wbp-hint">{t('modelsEmpty')}</span>} className="wbp-rowFlush" />
        : models.map(model => (
            <div key={model.id} className="wbp-modelRow">
              <span className="wbp-modelMain">
                {/*
                  * A model excluded by the filter wears its state on the row.
                  *
                  * The mark is the PICKER's answer, not a second checkbox: the
                  * selection is edited in the filter row above, and a tick here
                  * would be a control that duplicates it while looking like it
                  * meant something else. Reading it here is what makes the two
                  * lists line up at a glance — every model the product offers,
                  * with the ones that will not reach DSH marked.
                  *
                  * Absent when the filter is off, because then nothing is
                  * excluded and a column of identical dim rows would read as a
                  * state rather than as the absence of one.
                  */}
                {!filterOn || models.length === 0 || pickerSelection.includes(model.id) ? null : (
                  // The mark means ONE thing: this model is excluded by the filter
                  // above. It is therefore absent from the model the filter KEEPS,
                  // which is why a single row without a dot is the expected
                  // picture with a one-model allowlist — not a missing status.
                  <span
                    className="wbp-modelFiltered"
                    title={t('filterModelsExcludedHint')}
                    aria-label={t('filterModelsExcludedHint')}
                  />
                )}
                <span className="wbp-modelName" title={model.name}>{model.name}</span>
                {/* Promotions sit beside the name: they are part of what the
                    row is offering, and a separate column would push the
                    switch off the edge. */}
                {promotionChips(model, t('freeModel')).map(chip => (
                  <Badge key={chip} tone="ok">{chip}</Badge>
                ))}
                {model.credits === undefined
                  ? model.rateUnknown === true ? <span className="wbp-hint">{t('rateUnknown')}</span> : null
                  : <span className="wbp-hint">{t('rate', { rate: model.credits })}</span>}
              </span>
              {/*
                * The control column is where "from top to bottom, tidy" is
                * decided, and it needs the pieces in a fixed order and fixed
                * slots to survive rows whose contents differ:
                *
                *   [ probe result ] [ Detect button ] [ context window ]
                *
                * `wbp-modelControl` is a CSS grid with a column per slot, so the
                * context figure sits at the same x on every row whether or not
                * that row has a button — with inline flow, a row without a
                * button would slide its figure left and the column would read as
                * ragged.
                */}
              <span className="wbp-modelControl">
                <span className="wbp-modelProbeResult">
                  {probe === undefined || !probe.candidates.includes(model.id) ? null : (() => {
                    const result = probe.results.find(entry => entry.id === model.id)
                    if (result === undefined) return null
                    return (
                      <Badge tone="ok" title={t('probeTooltipVerified', { levels: (result.efforts ?? []).join(' / ') })}>
                        {result.validation === 'validating' && (result.efforts?.length ?? 0) > 0
                          ? result.efforts.join(' / ')
                          : t(result.validation === 'non-validating' ? 'probeResultNotValidating' : 'probeResultUnknown')}
                      </Badge>
                    )
                  })()}
                </span>
                <span className="wbp-modelProbeAction">
                  {probe === undefined || !probe.candidates.includes(model.id) ? null : (
                    <ActionButton
                      label={t((() => {
                        const result = probe.results.find(entry => entry.id === model.id)
                        return result === undefined ? 'probeStart' : 'probeRedetect'
                      })())}
                      title={t('probeTooltipIdle', { model: model.name })}
                      disabled={busy || probe.running === true}
                      onClick={() => { setPending(model.id) }}
                    />
                  )}
                </span>
                <span className="wbp-modelContext">
                  {model.contextChoices === undefined || model.contextChoices.length < 2
                    // A single declared window has nothing to switch between, so
                    // it is reported as a fact rather than offered as a control.
                    ? model.contextWindow === undefined
                      ? null
                      : <span className="wbp-hint">{t('contextHeading')} {shortTokens(model.contextWindow)}</span>
                    : <SegmentedField
                        label={`${t('contextLabel')}: ${model.name}`}
                        disabled={busy}
                        value={String(model.contextChoice ?? model.contextChoices[0] ?? 0)}
                        options={model.contextChoices.map(length => ({
                          value: String(length),
                          // Short and honest at both scales: 1M, not 1000K.
                          label: shortTokens(length),
                          title: t('contextSwitchTitle', { size: shortTokens(length) }),
                        }))}
                        onChange={next => { onContext(model.id, Number(next)) }}
                      />}
                </span>
              </span>
              {/*
                * The confirmation opens inside the row it belongs to, so the
                * question ("send real requests to this model?") stays beside the
                * button that asked it instead of appearing at the bottom of a long
                * list, a screen away from its subject.
                */}
              {pending !== model.id ? null : (
                <div className="wbp-confirmBar">
                  <p className="wbp-confirmText">{t('probeConfirmBody', { model: model.name })}</p>
                  <div className="wbp-dialogActions">
                    <ActionButton label={t('cancel')} onClick={() => { setPending(undefined) }} />
                    <ActionButton
                      label={t('probeConfirmAction')}
                      tone="primary"
                      disabled={busy || probe?.running === true}
                      onClick={() => { setPending(undefined); onDetect(model.id) }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
    </>
  )
}

/**
 * The model lists, one product at a time.
 *
 * Why one list instead of two stacked ones: the two rosters are long (twenty
 * rows each) and share most of their model ids, so showing both doubled the page
 * height for information a reader consults one product at a time. The switch
 * sits where a reader already looks for the list's controls — left of Refresh,
 * on the heading line — and slides, so flipping between the products reads as
 * changing which list is shown rather than as reloading the page.
 *
 * A segmented control rather than tabs: the two products are the same kind of
 * thing seen alternately, not two destinations. It is the platform's own
 * segmented shape (a raised pill sliding under the selected segment), which is
 * what every other two-way choice in this plugin already uses.
 */
function ModelsSection({ variants, statuses, probeFor, busy, t, context, stagedModels, onContext, onRefresh, onDetect, onClearProbe, onStage }: {
  variants: readonly WorkBuddyCardVariant[]
  statuses: Partial<Record<string, WorkBuddyWebStatus>>
  probeFor: (variant: WorkBuddyCardVariant) => WorkBuddyWebProbeSection | undefined
  busy: boolean
  t: Translate
  context: WorkBuddyExternalOpenOptions['context']
  stagedModels: Record<string, { filterOn: boolean, allowlist: readonly string[] }>
  onContext: (variant: WorkBuddyCardVariant, model: string, length: number) => void
  onRefresh: (variant: WorkBuddyCardVariant) => void
  onDetect: (variant: WorkBuddyCardVariant, model: string) => void
  onClearProbe: (variant: WorkBuddyCardVariant) => void
  onStage: (variant: WorkBuddyCardVariant, next: { filterOn: boolean, allowlist: readonly string[] } | undefined) => void
}): React.ReactNode {
  /**
   * Which list is on screen.
   *
   * Seeded with the first product and then left alone: the page keeps the
   * choice for its lifetime, because a reader flipping to the other product is
   * doing a comparison, and a re-render that snapped back would undo it.
   */
  const [shown, setShown] = useState(variants[0]?.id ?? '')
  const active = variants.find(variant => variant.id === shown) ?? variants[0]
  const count = (variant: WorkBuddyCardVariant): number => {
    const status = statuses[variant.id]
    return status !== undefined && status.status === 'signed-in' ? status.models?.length ?? 0 : 0
  }
  if (active === undefined) return null
  return (
    <SettingsGroup
      title={t('modelsHeading')}
      action={(
        <>
          {variants.length < 2 ? null : (
            <SegmentedField
              label={t('modelsSwitchLabel')}
              value={active.id}
              disabled={busy}
              options={variants.map(variant => ({
                value: variant.id,
                // The product name alone: the count is in the heading and in
                // each row, so a number here would be a third place to read it
                // and a second way for the two to disagree.
                label: variant.appName,
                title: t('modelsSwitchTitle', { product: variant.appName, count: count(variant) }),
              }))}
              onChange={setShown}
            />
          )}
          <ActionButton label={t('modelsRefresh')} disabled={busy} onClick={() => { onRefresh(active) }} />
        </>
      )}
    >
      {/*
        * `key` on the product: switching remounts the block, which is what drops
        * the previous product's open probe confirmation. Without it a pending
        * "send test requests to this model?" would survive the switch and point
        * at a model id the new list may not even carry.
        */}
      <ModelsBlock
        key={active.id}
        variant={active}
        status={statuses[active.id]}
        probe={probeFor(active)}
        busy={busy}
        t={t}
        context={context}
        staged={stagedModels[active.id]}
        onContext={(model, length) => { onContext(active, model, length) }}
        onRefresh={() => { onRefresh(active) }}
        onDetect={model => { onDetect(active, model) }}
        onClearProbe={() => { onClearProbe(active) }}
        onStage={next => { onStage(active, next) }}
      />
    </SettingsGroup>
  )
}

/** One pooled account together with the product it belongs to. */
interface TaggedAccount {
  account: WorkBuddyWebAccount
  variant: WorkBuddyCardVariant
}

/**
 * The account area: one card per product, every account of that product inside
 * the same card.
 *
 * Why one card per product rather than one card per account: an account is a row
 * of the POOL, not a surface of its own. A card per account made a two-account
 * pool look like two features, each with its own border, padding and header, and
 * the figures a reader compares sat in separate frames. One card states the
 * product once, its pool total once, and lists its accounts as rows — the shape
 * every account list in this UI already uses.
 *
 * The products stay apart because their credits are not convertible: a shared
 * total would be a number that describes nothing, and the two pools are never
 * interchangeable.
 */
function AccountsSection({ entries, statuses, busy, now, t, onAdd, onAction, onRefreshAll }: {
  entries: readonly TaggedAccount[]
  statuses: Partial<Record<string, WorkBuddyWebStatus>>
  busy: boolean
  now: number
  t: Translate
  onAdd: () => void
  onAction: (variant: WorkBuddyCardVariant, action: WorkBuddyAccountAction) => void
  /** Re-read every signed-in account's balance and state across both products. */
  onRefreshAll: () => void
}): React.ReactNode {
  return (
    <SettingsGroup
      title={t('accountHeading')}
      // Both heading actions are actions on the whole list rather than on one
      // row: adding picks a product first, refreshing re-reads both pools.
      action={(
        <>
          {entries.length === 0 ? null : (
            <ActionButton
              label={t('accountRefreshAll')}
              disabled={busy}
              title={t('accountRefreshAllHint')}
              onClick={onRefreshAll}
            />
          )}
          <ActionButton label={t('accountAdd')} disabled={busy} onClick={onAdd} />
        </>
      )}
      description={entries.length > 1 ? t('accountRotateHint') : t('accountEmptyHint')}
    >
      {/*
        * One line per product whose status read failed, naming the product and
        * the host's own diagnosis. Without it the product simply vanished from
        * the page — no accounts, no models, no explanation — and every action on
        * it answered "request failed".
        */}
      {CARD_VARIANTS.map(variant => {
        const status = statuses[variant.id]
        if (status === undefined || status.status !== 'error') return null
        return (
          <p key={variant.id} className="wbp-rowError" role="status">
            {variant.appName}: {status.message}
          </p>
        )
      })}
      {/*
        * A desktop-credential problem while the pool is otherwise healthy: the
        * card looks fine, so nothing else would tell the user that the file they
        * pointed the plugin at is being refused.
        */}
      {CARD_VARIANTS.map(variant => {
        const status = statuses[variant.id]
        if (status === undefined || status.status !== 'signed-in' || status.desktopError === undefined) return null
        return (
          <p key={variant.id} className="wbp-notice" role="status">
            {variant.appName}: {status.desktopError}
          </p>
        )
      })}
      <div className="wbp-productCards">
        {CARD_VARIANTS.map(variant => (
          <ProductAccountsCard
            key={variant.id}
            variant={variant}
            accounts={entries.filter(entry => entry.variant.id === variant.id).map(entry => entry.account)}
            status={statuses[variant.id]}
            busy={busy}
            now={now}
            t={t}
            onAction={action => { onAction(variant, action) }}
          />
        ))}
      </div>
    </SettingsGroup>
  )
}

/**
 * One product's pooled accounts, in one card.
 *
 * What the card states, and in which order:
 *
 *   [product name]                       [remaining / capacity]
 *   [status dot] [account name]  [state]              ⋮
 *                [grey line: 剩余 / 已用 / 请求 / token / 恢复]
 *   …
 *
 * The head total is the POOL's, summed over the accounts whose balance was
 * actually read — an account whose lookup failed contributes nothing rather
 * than a zero, because a zero would silently shrink a figure the reader is
 * using to decide whether they need to add another account.
 *
 * A product with no accounts and nothing wrong to report renders nothing: a
 * permanent "no accounts" card for a product the user does not use turns a
 * status list into a reminder.
 */
function ProductAccountsCard({ variant, accounts, status, busy, now, t, onAction }: {
  variant: WorkBuddyCardVariant
  accounts: readonly WorkBuddyWebAccount[]
  status: WorkBuddyWebStatus | undefined
  busy: boolean
  now: number
  t: Translate
  onAction: (action: WorkBuddyAccountAction) => void
}): React.ReactNode {
  const detail = status === undefined
    ? undefined
    : status.status === 'error' ? status.message
      : status.status === 'signed-out' ? status.reason
        : undefined
  if (accounts.length === 0 && detail === undefined) return null

  const known = accounts.map(account => account.credits).filter((value): value is number => typeof value === 'number')
  const total = known.length === 0 ? undefined : known.reduce((sum, value) => sum + value, 0)
  const capacityKnown = accounts.length > 0
    && accounts.every(account => account.credits === undefined || account.creditsTotal !== undefined)
  const capacity = capacityKnown
    ? accounts.reduce((sum, account) => sum + (account.creditsTotal ?? 0), 0)
    : 0
  const ready = accounts.filter(account => account.available).length

  return (
    <section className="wbp-productCard" aria-label={variant.appName}>
      <div className="wbp-productHead">
        <span className="wbp-productName">{variant.appName}</span>
        {accounts.length === 0 ? null : (
          <span className="wbp-productCount">{t('cardReady', { ready, total: accounts.length })}</span>
        )}
        <span className="wbp-spacer" />
        <span className="wbp-productTotal">
          {total === undefined
            // No balance read for any account yet: an em dash, never a zero.
            ? accounts.length === 0 ? '' : '—'
            : capacity > 0
              ? t('accountMetaRemainingOf', { remaining: formatCredit(total), total: formatCredit(capacity) })
              : t('accountMetaRemaining', { remaining: formatCredit(total) })}
        </span>
      </div>
      {detail === undefined ? null : <p className="wbp-productDetail">{detail}</p>}
      {accounts.length === 0 ? null : (
        <div className="wbp-accountList">
          {accounts.map(account => (
            <AccountRow
              key={account.id}
              account={account}
              busy={busy}
              now={now}
              t={t}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One account's check-in state, in one sentence.
 *
 * The record and the run answer different questions, so the line states the
 * record first (when this account last claimed a day) and appends the most
 * recent outcome only when it disagrees — a successful run repeats what the
 * record already says, and saying it twice reads as two separate events.
 */
function checkinLine(row: WorkBuddyWebCheckinRow, t: Translate): string {
  const parts: string[] = []
  if (row.day !== undefined) parts.push(t('checkinRowDay', { day: row.day }))
  else parts.push(t('checkinRowNever'))
  if (row.state === 'failed') parts.push(t('checkinRowFailed', { reason: row.reason ?? '' }))
  else if (row.state === 'skipped') parts.push(t('checkinRowSkipped', { reason: row.reason ?? '' }))
  return parts.join(' · ')
}

/** The list a user picks a product from before the login dialog opens. */
function ProductPicker({ t, onPick, onCancel }: {
  t: Translate
  onPick: (variant: WorkBuddyCardVariant) => void
  onCancel: () => void
}): React.ReactNode {
  return createPortal(
    <div className="wbp-overlay" role="presentation" onClick={event => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="wbp-dialog" role="dialog" aria-modal="true" aria-label={t('accountAddTitle')}>
        <h3 className="wbp-dialogTitle">{t('accountAddTitle')}</h3>
        {/* The question is stated, not implied by two bare buttons: an account
            belongs to one product, and the two pools never mix. */}
        <p className="wbp-dialogBody">{t('accountAddPickHint')}</p>
        <ActionButton label={t('accountAddCn')} onClick={() => { onPick(CARD_VARIANTS[0] as WorkBuddyCardVariant) }} />
        <ActionButton label={t('accountAddAi')} onClick={() => { onPick(CARD_VARIANTS[1] as WorkBuddyCardVariant) }} />
        <div className="wbp-dialogActions">
          <ActionButton label={t('cancel')} onClick={onCancel} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The save bar's leading mark once there is an outcome: a circled tick or a
 * circled bang, ported from the reference implementation's `SaveBarIcon` (same
 * 16px viewBox, same 1.6 stroke). Drawn rather than a glyph character so it
 * inherits the bar's tone colour and never picks up a font's own metrics.
 */
function SaveBarGlyph({ tone }: { tone: 'success' | 'error' }): React.ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      {tone === 'success' ? <path d="M5.2 8.2l1.9 1.9 3.7-3.9" /> : <path d="M8 4.8v3.6M8 11.1v.1" />}
    </svg>
  )
}

/** How one product can be signed into. */
type SignInMode = 'qr' | 'web' | 'token' | 'desktop'

/**
 * The sign-in dialog for one product.
 *
 * Both products offer a browser sign-in and a pasted token. Only the CN product
 * offers the scannable code: the international QR endpoint answers, but there is
 * no app on a phone that completes it, so showing a code would be offering a
 * path that cannot be walked. The international product's browser route is
 * therefore a plain link to its console rather than a QR.
 *
 * The browser route only *starts* a sign-in — it is the console, and the plugin
 * cannot observe what happens there. So the token half is not a fallback for it
 * but its other half: the user signs in on the web, copies the token, and pastes
 * it. The copy says so rather than leaving the two tabs unexplained.
 */
function AddAccountDialog({ variant, t, busy, error, onCancel, onSubmitQr, onPollQr, onSubmitToken, onSubmitDesktop, onOpenLink }: {
  variant: WorkBuddyCardVariant
  t: Translate
  busy: boolean
  error?: string
  onCancel: () => void
  onSubmitQr: () => Promise<WorkBuddyQrChallenge | undefined>
  onPollQr: (state: string) => Promise<boolean>
  onSubmitToken: (token: string) => Promise<boolean>
  /** Adopt the desktop app's own sign-in; false when the host refused or none exists. */
  onSubmitDesktop: () => Promise<boolean>
  /** Hand the minted sign-in page to the user's browser; false when it could not. */
  onOpenLink: (url: string) => Promise<boolean>
}): React.ReactNode {
  const qrSupported = variant.id === 'workbuddy'
  const [mode, setMode] = useState<SignInMode>(qrSupported ? 'qr' : 'web')
  const [challenge, setChallenge] = useState<WorkBuddyQrChallenge>()
  /**
   * Whether the last hand-off failed.
   *
   * A hand-off can only fail in one place (the browser route, where the dialog
   * itself asks for the page), and when it does the address has to reach the
   * user: every strategy in the chain is silent by design, so without this the
   * dialog would keep a button that appears to work and does not.
   */
  const [linkFailed, setLinkFailed] = useState(false)
  const [token, setToken] = useState('')
  const [remaining, setRemaining] = useState(0)
  const stopped = useRef(false)
  /**
   * Whether this dialog has already asked for a challenge.
   *
   * A ref, not the `challenge` state: a failed `add` answers with no challenge
   * at all, so keying the effect on the state alone would re-run it on every
   * render the failure caused, firing `add` in a loop. The dialog asks once per
   * opening and offers the explicit actions below after that.
   */
  const asked = useRef(false)
  /**
   * Whether this dialog has already tried the desktop option.
   *
   * Same one-shot rule as `asked`: reading the app's file is a real action (it
   * clears any earlier removal), so it happens once per opening and the error
   * below is how a failure is reported.
   */
  const askedDesktop = useRef(false)

  /**
   * Mint a challenge as soon as a route that needs one is shown.
   *
   * Both routes do: the code route renders the URL as a QR, and the browser
   * route opens it. That is what makes the browser route a real sign-in rather
   * than a link to a marketing page — the `authUrl` the host mints *is* the
   * product's login page, carrying the state the host is already polling.
   */
  useEffect(() => {
    if ((mode !== 'qr' && mode !== 'web') || asked.current) return
    asked.current = true
    stopped.current = false
    void onSubmitQr().then(next => {
      if (stopped.current || next === undefined) return
      setChallenge(next)
    })
  }, [mode, onSubmitQr])

  /**
   * Try the desktop option as soon as it is chosen.
   *
   * Reading the app's own file is fast and local, so a button would only repeat
   * the choice the segment already made; a failure surfaces through `error`
   * below and the user can pick another route.
   */
  useEffect(() => {
    if (mode !== 'desktop' || askedDesktop.current) return
    askedDesktop.current = true
    void onSubmitDesktop()
  }, [mode, onSubmitDesktop])

  /**
   * Open the minted login page in the system browser, once.
   *
   * Automatic rather than behind a button: the user already chose "sign in on
   * the web", so making them click again to reach the page that choice names
   * would be asking the same question twice. A ref keeps a re-render from
   * opening a second tab.
   */
  const opened = useRef(false)
  useEffect(() => {
    if (mode !== 'web' || challenge === undefined || opened.current) return
    opened.current = true
    void onOpenLink(challenge.authUrl).then(opened => { if (!opened) setLinkFailed(true) })
  }, [mode, challenge, onOpenLink])

  useEffect(() => {
    if (challenge === undefined) return
    setLinkFailed(false)
    setRemaining(Math.max(0, challenge.expiresAtMs - Date.now()))
    const tick = window.setInterval(() => { setRemaining(Math.max(0, challenge.expiresAtMs - Date.now())) }, 1_000)
    return () => { window.clearInterval(tick) }
  }, [challenge])

  useEffect(() => {
    if (challenge === undefined || stopped.current) return
    const poll = window.setInterval(() => {
      void onPollQr(challenge.state).then(keep => { if (!keep) stopped.current = true })
    }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(poll) }
  }, [challenge, onPollQr])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onCancel])

  // Leaving the QR half releases the challenge; the host keeps the state until
  // it expires, and an abandoned one is dead weight.
  useEffect(() => () => { stopped.current = true }, [])

  return createPortal(
    <div className="wbp-overlay" role="presentation" onClick={event => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="wbp-dialog" role="dialog" aria-modal="true" aria-label={variant.appName}>
        <h3 className="wbp-dialogTitle">{t('accountAddTitle')}</h3>
        <div className="wbp-dialogActions" style={{ justifyContent: 'center' }}>
          <SegmentedField
            label={t('accountActionLogin')}
            value={mode}
            options={qrSupported
              // The scannable code is the CN product's default because that is
              // the flow its app completes on its own.
              ? [
                  { value: 'qr', label: t('accountLoginQr') },
                  { value: 'desktop', label: t('accountLoginDesktop') },
                  { value: 'token', label: t('accountLoginToken') },
                ]
              : [
                  { value: 'web', label: t('accountLoginWeb') },
                  { value: 'desktop', label: t('accountLoginDesktop') },
                  { value: 'token', label: t('accountLoginToken') },
                ]}
            onChange={next => { setMode(next as SignInMode) }}
          />
        </div>

        {/*
          * The address itself, when no strategy could open it.
          *
          * Shown inside the dialog rather than as an alert because it is a thing
          * to copy, and a modal's text is not selectable. Every strategy above is
          * silent when it fails, so this is the only place the user learns that
          * the page did not open — and the one way through without it is to read
          * the URL off the QR code with another device.
          */}
        {!linkFailed || challenge === undefined ? null : (
          <div className="wbp-linkFallback">
            <p className="wbp-dialogBody">{t('accountOpenLinkFailed')}</p>
            <input
              className="wbp-input"
              readOnly
              value={challenge.authUrl}
              aria-label={t('accountOpenLink')}
              onFocus={event => { event.currentTarget.select() }}
            />
          </div>
        )}

        {mode === 'desktop'
          ? <>
              <p className="wbp-dialogBody">{t('accountDesktopBody')}</p>
              {busy ? <span className="wbp-hint">{t('loading')}</span> : null}
            </>
          : mode === 'qr'
          ? <>
              <p className="wbp-dialogBody">{t('accountAddBody')}</p>
              <div className="wbp-qrFrame">
                {challenge === undefined
                  ? <span className="wbp-hint">{t('loading')}</span>
                  : <QrCanvas text={challenge.authUrl} modulePixels={232} />}
              </div>
              {challenge === undefined ? null : (
                <p className="wbp-dialogBody">{t('accountAddWaiting', { seconds: Math.ceil(remaining / 1_000) })}</p>
              )}
              <div className="wbp-dialogActions">
                <ActionButton
                  label={t('accountOpenLink')}
                  disabled={challenge === undefined}
                  // System browser, not an in-app window: the sign-in happens on
                  // the provider's own page, where the user's existing session
                  // and password manager already live. The chain behind this
                  // click is what makes that work on the desktop too — see
                  // `open-external`.
                  onClick={() => {
                    if (challenge === undefined) return
                    void onOpenLink(challenge.authUrl).then(opened => { setLinkFailed(!opened) })
                  }}
                />
              </div>
            </>
          : mode === 'web'
            ? <>
                <p className="wbp-dialogBody">{t('accountWebBody')}</p>
                {/*
                  * The same wait the code route shows, because it is the same
                  * wait: the host is polling the state either way, so a sign-in
                  * completed in the browser lands in the pool on its own.
                  */}
                {challenge === undefined
                  ? <span className="wbp-hint">{t('loading')}</span>
                  : <p className="wbp-dialogBody">{t('accountWebWaiting', { seconds: Math.ceil(remaining / 1_000) })}</p>}
                <div className="wbp-dialogActions">
                  <ActionButton
                    label={t('accountOpenLink')}
                    disabled={challenge === undefined}
                    // The tab usually opened on its own; this is the way back to
                    // it when the browser blocked the pop-up, the user closed it
                    // by accident, or the desktop shell swallowed the automatic
                    // hand-off entirely.
                    onClick={() => {
                      if (challenge === undefined) return
                      void onOpenLink(challenge.authUrl).then(opened => { setLinkFailed(!opened) })
                    }}
                  />
                </div>
              </>
            : <>
              <p className="wbp-dialogBody">{t('accountTokenBody')}</p>
              <textarea
                className="wbp-tokenArea"
                value={token}
                placeholder={t('accountTokenPlaceholder')}
                spellCheck={false}
                onChange={event => { setToken(event.target.value) }}
              />
              <div className="wbp-dialogActions">
                <ActionButton
                  label={busy ? t('accountChecking') : t('accountSubmit')}
                  tone="primary"
                  disabled={busy || token.trim() === ''}
                  onClick={() => { void onSubmitToken(token) }}
                />
              </div>
            </>}

        {error === undefined ? null : (
          <p className="wbp-rowError">{error}</p>
        )}
        <div className="wbp-dialogActions">
          <ActionButton label={t('cancel')} onClick={onCancel} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------- page */

/**
 * What one allowlist write did.
 *
 * `unsupported` is not a failure but a capability answer: an older host answers
 * 400 to an action it does not know, which is exactly when the client can still
 * express the same filter through the per-model hide list.
 */
type AllowlistWriteResult = 'updated' | 'unsupported' | 'failed'

/** Props injected for the settings page. */
export interface WorkBuddySettingsPageProps {
  t: Translate
  /**
   * The cordis seam source a sign-in hand-off may use beyond `window.open` —
   * the right sidebar's browser, when this profile mounts one.
   *
   * Injected rather than reached for inside the dialog for the reason the other
   * external services are: this bundle must render on a profile with no sidebar
   * at all, and a missing seam has to degrade to the next strategy instead of
   * throwing out of the settings page.
   */
  context?: WorkBuddyExternalOpenOptions['context']
  /**
   * Re-read the status documents for the SURFACES OUTSIDE this page — the
   * sidebar card and the dashboard.
   *
   * They poll on their own minute-long schedule, so without this a preference
   * that changes how the card is DRAWN (the sidebar credit line) would appear to
   * do nothing for up to a minute. Injected rather than reached for: the store
   * belongs to the client entry point that creates both surfaces, and a page
   * that imported it would tie itself to a module the harness may not mount.
   */
  refreshPanel?: () => void
}

/**
 * The page itself: one card, two product blocks.
 *
 * Each product is driven by its own status document, so a failure or a slow
 * answer on one never blocks or blanks the other.
 */
export function WorkBuddySettingsPage({ t, context, refreshPanel }: WorkBuddySettingsPageProps): React.ReactNode {
  // Seeded from the cache so the first paint already carries the accounts and
  // balances the last visit saw, instead of an empty page while the live read is
  // in flight. Read once, in the initializer: a later render must not resurrect a
  // document the user has since replaced.
  const [statuses, setStatuses] = useState<Partial<Record<string, WorkBuddyWebStatus>>>(() => {
    const cached: Partial<Record<string, WorkBuddyWebStatus>> = {}
    for (const variant of CARD_VARIANTS) {
      const document = readCachedStatus(variant.id)
      if (document !== undefined) cached[variant.id] = document
    }
    return cached
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState<WorkBuddyCardVariant>()
  const [now, setNow] = useState(() => Date.now())
  /**
   * Uncommitted model filters, one per product.
   *
   * The settings page collects model edits and writes them on Save, matching the
   * reference implementation's staged form: assembling "only these models" is a
   * multi-step decision (open the picker, search, tick, close), and a page that
   * wrote on every close would put three intermediate filters into the host's
   * store on the way to the one the user meant. A per-product map rather than a
   * single draft because the two products' filters are independent rows on one
   * page, and staging one must not discard the other.
   *
   * Each entry is ABSOLUTE, not a patch: `allowlist.length === 0` is the "no
   * filter" state, so there is no precedence puzzle between the draft and the
   * document.
   */
  const [stagedModels, setStagedModels] = useState<Record<string, { filterOn: boolean, allowlist: readonly string[] }>>({})
  /** True while the staged edits are being written; the bar says so. */
  const [saving, setSaving] = useState(false)
  /**
   * An informational line about what a save actually did.
   *
   * Not `error`: the old-host path is a downgrade, not a failure — the filter is
   * in force, it is just stored as a hide list. Rendering it as an error would
   * turn the save bar red and (worse) hide the "Saved" acknowledgement that says
   * the write landed.
   */
  const [notice, setNotice] = useState<string>()
  /** True for the moment after a save landed, which is all the bar needs to say. */
  const [justSaved, setJustSaved] = useState(false)
  const mounted = useRef(true)
  /**
   * The latest documents, readable from a callback that must not re-create
   * itself: `readAll` is a dependency of the polling effect, so rebuilding it on
   * every document would restart the interval on every sweep.
   */
  const statusesRef = useRef<Partial<Record<string, WorkBuddyWebStatus>>>(statuses)
  statusesRef.current = statuses
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const tick = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(tick) }
  }, [])
  /**
   * Let the "Saved" state retire on its own.
   *
   * The bar exists to be noticed and then to get out of the way: a save that
   * landed has nothing left to act on, and a bar that stayed until the next
   * click would sit over the page's last rows for as long as the reader is
   * reading. A timer rather than a dismiss button for the same reason —
   * confirming a confirmation is one interaction too many.
   */
  useEffect(() => {
    if (!justSaved) return
    const timer = window.setTimeout(() => { setJustSaved(false) }, 3_000)
    return () => { window.clearTimeout(timer) }
  }, [justSaved])

  const readAll = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const answers = await Promise.all(CARD_VARIANTS.map(async variant => {
      const result = await readWorkBuddyStatus(variant, signal)
      // An unreadable read is dropped, so the previous document stays: the page
      // keeps showing what it last knew rather than blanking over a transient
      // failure. A refused one is kept as an ERROR document, because the host's
      // own sentence is the only thing that tells the user what to fix.
      if (result.state === 'unreadable') return undefined
      if (result.state === 'refused') {
        return [variant.id, { status: 'error', message: result.message } satisfies WorkBuddyWebStatus] as const
      }
      return [variant.id, result.status] as const
    }))
    if (!mounted.current || signal?.aborted === true) return
    // Merge rather than replace: an unreadable answer is dropped (above), and a
    // product whose route answered nothing must keep the document already on
    // screen — including the one the cache seeded — instead of blanking it.
    const next: Partial<Record<string, WorkBuddyWebStatus>> = { ...statusesRef.current }
    for (const answer of answers) {
      if (answer === undefined) continue
      next[answer[0]] = answer[1]
      writeCachedStatus(answer[0], answer[1])
    }
    statusesRef.current = next
    setStatuses(next)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void readAll(controller.signal)
    const tick = window.setInterval(() => { void readAll(controller.signal) }, REFRESH_INTERVAL_MS)
    return () => {
      window.clearInterval(tick)
      controller.abort()
    }
  }, [readAll])

  /** The control key, which the status documents hand out in both sign-in states. */
  const keyFor = useCallback((variant: WorkBuddyCardVariant): string | undefined => {
    const status = statuses[variant.id]
    return status !== undefined && 'probeKey' in status ? status.probeKey : undefined
  }, [statuses])

  /**
   * Why this product cannot be written to right now, in the host's own words.
   *
   * The control key arrives with the status document, so a read that failed (or a
   * signed-out host) leaves the page unable to POST anything. That used to be
   * reported as a bare "request failed" — the reported symptom when adding the
   * international product — even though the host had said exactly what was wrong
   * and the sentence was sitting in the response body.
   */
  const blockedReason = useCallback((variant: WorkBuddyCardVariant): string | undefined => {
    const status = statuses[variant.id]
    if (status === undefined) return undefined
    if (status.status === 'error') return status.message
    if (status.status === 'signed-out') return status.reason
    return undefined
  }, [statuses])

  const run = useCallback(async (variant: WorkBuddyCardVariant, action: WorkBuddyAccountAction): Promise<WorkBuddyAccountResult | undefined> => {
    const key = keyFor(variant)
    if (key === undefined) {
      setError(blockedReason(variant) ?? t('requestFailed'))
      return undefined
    }
    const response = await fetch(variant.accountPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify(action),
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message = typeof value === 'object' && value !== null && 'error' in value
        ? String((value as Record<string, unknown>)['error'])
        : `HTTP ${String(response.status)}`
      setError(message)
      return undefined
    }
    return value as WorkBuddyAccountResult
  }, [keyFor, t])

  const submitQr = useCallback(async (variant: WorkBuddyCardVariant): Promise<WorkBuddyQrChallenge | undefined> => {
    setError(undefined)
    setBusy(true)
    try {
      const result = await run(variant, { action: 'add' })
      if (result?.challenge === undefined) {
        setError(result?.reason ?? t('requestFailed'))
        return undefined
      }
      return result.challenge
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [run, t])

  /**
   * Hand one sign-in page to the user's own browser.
   *
   * The chain lives in `open-external`; what this adds is the two facts only
   * the page has — which route serves the product the dialog is open for, and
   * the control key that proves this page was the one the host talked to. A
   * signed-out host hands out no key, so the host strategy is simply skipped and
   * the chain falls through to the browser's own APIs.
   *
   * Returns whether the link was handed off at all, so the dialog can name the
   * address instead of leaving the user with a button that did nothing.
   */
  const openSignInPage = useCallback(async (variant: WorkBuddyCardVariant, url: string): Promise<boolean> => {
    const key = keyFor(variant)
    const options: WorkBuddyExternalOpenOptions = { probePath: variant.probePath }
    // Assigned rather than sent as `undefined`: the option types are exact, and
    // an explicit undefined would be a key the host is asked to check.
    if (key !== undefined) options.key = key
    if (context !== undefined) options.context = context
    return openExternalLink(url, options)
  }, [context, keyFor])

  const pollQr = useCallback(async (variant: WorkBuddyCardVariant, state: string): Promise<boolean> => {
    const result = await run(variant, { action: 'poll', state })
    if (result === undefined) return false
    if (result.state === 'waiting') return true
    if (result.state === 'added') {
      setAdding(undefined)
      setError(undefined)
      await readAll()
      return false
    }
    setError(result.reason ?? t(result.state === 'expired' ? 'accountQrExpired' : 'accountQrInvalid'))
    return false
  }, [readAll, run, t])

  const submitToken = useCallback(async (variant: WorkBuddyCardVariant, token: string): Promise<boolean> => {
    setError(undefined)
    setBusy(true)
    try {
      const result = await run(variant, { action: 'add-cookie', token })
      if (result === undefined) return false
      if (result.state !== 'added') {
        setError(result.reason ?? t('requestFailed'))
        return false
      }
      setAdding(undefined)
      await readAll()
      return true
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [readAll, run, t])

  const submitDesktop = useCallback(async (variant: WorkBuddyCardVariant): Promise<boolean> => {
    setError(undefined)
    setBusy(true)
    try {
      const result = await run(variant, { action: 'adopt-desktop' })
      if (result === undefined) return false
      if (result.state !== 'added') {
        setError(result.reason ?? t('requestFailed'))
        return false
      }
      setAdding(undefined)
      await readAll()
      return true
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [readAll, run, t])

  /**
   * Ask the host to re-fetch this product's model list.
   *
   * Shares the probe route's `refresh` action rather than the account route:
   * the work is a catalog fetch, and that is what the probe route already does.
   */
  const refreshModels = useCallback((variant: WorkBuddyCardVariant): void => {
    const key = keyFor(variant)
    if (key === undefined) return
    setBusy(true)
    setError(undefined)
    void fetch(variant.probePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'refresh' }),
    })
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          setError(`HTTP ${String(response.status)}`)
        } else if (typeof value === 'object' && value !== null && 'state' in value && value.state === 'failed') {
          setError(String((value as Record<string, unknown>)['reason'] ?? t('requestFailed')))
        }
        await readAll()
      })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : t('requestFailed')) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [keyFor, readAll, t])

  /**
   * Detect one model's reasoning levels.
   *
   * A write on the probe route, beside its `refresh`: the probe endpoint owns
   * detection, and the account route owns the pool. Returns nothing — the
   * re-read afterwards is what updates the row.
   */
  const probeAction = useCallback((variant: WorkBuddyCardVariant, body: { action: 'probe', model: string } | { action: 'clear' }): void => {
    const key = keyFor(variant)
    if (key === undefined) return
    setBusy(true)
    setError(undefined)
    void fetch(variant.probePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          setError(`HTTP ${String(response.status)}`)
        } else if (typeof value === 'object' && value !== null && 'state' in value && value.state === 'unavailable') {
          // A detection that spent credit and could not finish has to say why;
          // silence would look like the button did nothing. The route's failure
          // state is `unavailable`, which is worth naming here — the obvious
          // guess of `failed` is a *different* action's state and would swallow
          // every real reason.
          setError(String((value as Record<string, unknown>)['reason'] ?? t('requestFailed')))
        }
        await readAll()
      })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : t('requestFailed')) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [keyFor, readAll, t])

  /**
   * Stage one product's model filter, or discard with `undefined`.
   *
   * Staging is pure local state: nothing here talks to the host, which is the
   * point of the save bar. A discard drops this product's entry and leaves the
   * other product's alone.
   */
  const stageModels = useCallback((variant: WorkBuddyCardVariant, next: { filterOn: boolean, allowlist: readonly string[] } | undefined): void => {
    setJustSaved(false)
    // Editing something new retires the previous outcome's messages — an error
    // or a note from the last save sitting over this edit would read as this
    // edit's.
    setError(undefined)
    setNotice(undefined)
    setStagedModels(current => {
      if (next === undefined) {
        if (!(variant.id in current)) return current
        const { [variant.id]: _dropped, ...rest } = current
        return rest
      }
      return { ...current, [variant.id]: next }
    })
  }, [])

  /** Discard every staged model edit, for the bar's Discard. */
  const discardStaged = useCallback((): void => {
    setStagedModels({})
    setError(undefined)
    setJustSaved(false)
  }, [])

  /**
   * Re-read every account's balance and state, for every product that has one.
   *
   * One write per variant rather than per account: the host's `refresh-credits`
   * drops that variant's whole cached credit map, so the next status read spends
   * one billing request per account — which is exactly what the user asked for
   * by pressing this, and what the ordinary minute-long sweep deliberately does
   * not do.
   *
   * Only the account section is refreshed. The model catalogs have their own
   * per-product Refresh buttons beside their headings, and folding them in here
   * would make one button answer two different questions (and spend an upstream
   * catalog request nobody asked for).
   *
   * A variant with no key (no document answered, or an older host withholding
   * the control key) is skipped rather than reported as a failure: the page is
   * already saying that product cannot be read, and this button is not the place
   * for a second copy of that sentence.
   */
  const refreshAllAccounts = useCallback((): void => {
    const targets = CARD_VARIANTS
      .map(variant => ({ variant, key: keyFor(variant) }))
      .filter((target): target is { variant: WorkBuddyCardVariant, key: string } => target.key !== undefined)
    if (targets.length === 0) {
      setError(t('requestFailed'))
      return
    }
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void Promise.all(targets.map(async ({ variant, key }) => {
      try {
        const response = await fetch(variant.accountPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'refresh-credits' } satisfies WorkBuddyAccountAction),
        })
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) return 'HTTP ' + String(response.status)
        if (typeof value === 'object' && value !== null && 'state' in value && value.state === 'failed') {
          return String((value as Record<string, unknown>)['reason'] ?? t('requestFailed'))
        }
        return undefined
      } catch (cause: unknown) {
        return cause instanceof Error ? cause.message : t('requestFailed')
      }
    }))
      .then(async failures => {
        const first = failures.find((failure): failure is string => failure !== undefined)
        if (first !== undefined) setError(first)
        await readAll()
        // The sidebar card and the composer badge read their own copies, so they
        // are told now rather than at their next minute tick.
        refreshPanel?.()
      })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : t('requestFailed')) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [keyFor, readAll, refreshPanel, t])

  const accountAction = useCallback((variant: WorkBuddyCardVariant, action: WorkBuddyAccountAction): void => {
    setError(undefined)
    setBusy(true)
    void run(variant, action)
      .then(async result => {
        if (result === undefined) return
        if (result.state === 'failed') setError(result.reason ?? t('requestFailed'))
        else if (action.action === 'test' && result.test !== undefined) {
          setError(result.test.ok ? undefined : `${t('accountTestFailed')}: ${result.test.message}`)
        }
        await readAll()
        // The card states the pool's accounts and credit, so a write that
        // changed either has to reach it now rather than within the minute.
        refreshPanel?.()
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [readAll, refreshPanel, run, t])

  /**
   * The preference values this page has just written, before the re-read lands.
   *
   * A write is a round trip plus a full re-read of both products' status routes,
   * and the re-read is the slow half: each route re-reads its pool, and on a
   * cold credit cache that is a billing request per account (measured here at
   * 0.35s for the CN route and 1.3s for the international one). Staging the
   * control's own value locally makes the switch move in the same click, and the
   * document replaces it when it arrives — the same "paint first, confirm after"
   * shape the status cache uses.
   *
   * Only the fields this page OWNS are staged; anything the host computes stays
   * whatever the document says.
   */
  /**
   * Which product's model list the page shows.
   *
   * The two rosters are long (twenty rows each) and share most of their ids, so
   * stacking them doubled the page for no gain: a reader works on ONE product's
   * list at a time. A switch instead of tabs because the two are the same kind of
   * thing seen alternately, not two destinations.
   *
   * Default follows the pool: the first product that actually has a model list.
   * A product with no models shows its empty state rather than a blank panel.
   */
  const [modelsShown, setModelsShown] = useState<string>(CARD_VARIANTS[0]?.id ?? '')
  const [writtenPreferences, setWrittenPreferences] = useState<{
    creditStyle?: WorkBuddySidebarCreditStyle
    creditVisible?: boolean
    composerVisible?: boolean
    probeControlVisible?: boolean
    checkinAuto?: boolean
  }>({})

  /** The bucket this product's preferences are keyed by, when the document has one. */
  const visibilityAccount = useCallback((variant: WorkBuddyCardVariant): string | undefined => {
    const status = statuses[variant.id]
    return status === undefined || !('visibility' in status) ? undefined : status.visibility?.account
  }, [statuses])

  /** The catalog rows the document currently publishes for one product. */
  const catalogIds = useCallback((variant: WorkBuddyCardVariant): readonly string[] => {
    const status = statuses[variant.id]
    return status === undefined || !('models' in status) ? [] : (status.models ?? []).map(model => model.id)
  }, [statuses])

  /**
   * Replace one product's model filter.
   *
   * A write on the probe route, beside the per-model visibility toggle: the two
   * edit different lists on the host (the hide-list and the allowlist), so one
   * cannot be expressed as the other. The account the document was rendered from
   * travels with the request — the host refuses a write aimed at a different
   * account than the one signed in, which is what keeps a stale page from
   * landing A's filter in B's bucket.
   *
   * Reports WHICH failure it was, because the caller answers them differently: an
   * unrecognized action is a host old enough to predate the feature, and that has
   * a working alternative (the per-model hide list — see {@link applyFilterByHiding});
   * anything else is an error the user has to read.
   */
  const allowlistAction = useCallback((variant: WorkBuddyCardVariant, ids: readonly string[]): Promise<AllowlistWriteResult> => {
    const key = keyFor(variant)
    const account = visibilityAccount(variant)
    // Refused locally rather than sent unguarded: the host requires the account
    // and there is no honest fallback, so a document without one cannot be
    // edited at all (an account with no stable uid has no bucket to key).
    if (key === undefined || account === undefined) return Promise.resolve('failed')
    setBusy(true)
    setError(undefined)
    // The result is returned, not swallowed: the model list mirrors the switch's
    // position locally so the list reacts within the same click, and that mirror
    // can only stay honest if it is told a write failed. Reporting it through
    // `error` alone was the reported defect — the switch stayed on over a filter
    // the host never accepted, so the next click looked like it did nothing.
    return fetch(variant.probePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'set-model-allowlist', allowlist: ids, account }),
    })
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          setError(response.status === 400 || response.status === 404
            ? t('filterModelsUnsupported')
            : `HTTP ${String(response.status)}`)
          await readAll()
          return response.status === 400 || response.status === 404 ? 'unsupported' : 'failed'
        }
        if (typeof value === 'object' && value !== null && 'state' in value && value.state !== 'updated') {
          setError(String((value as Record<string, unknown>)['reason'] ?? t('requestFailed')))
          await readAll()
          return 'failed'
        }
        await readAll()
        return 'updated'
      })
      .catch((cause: unknown): AllowlistWriteResult => {
        setError(cause instanceof Error ? cause.message : t('requestFailed'))
        return 'failed'
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [keyFor, readAll, t, visibilityAccount])

  /**
   * Enforce a filter through the per-model hide list, for a host that does not
   * know the allowlist action.
   *
   * The hide list is the plugin's oldest visibility write and every host build
   * has it, so this is the one way to make the switch work TODAY rather than
   * after a DSH restart. It is a translation, not the same write: `disabled`
   * names what to hide rather than what to keep, so the unticked models are
   * hidden and every ticked one is shown again. Applying the filter twice must
   * be idempotent (it is the same two sets), and the tick list itself is not
   * stored — this host has nowhere to put it — so the selection is derived from
   * the hide list on the next read.
   *
   * Unfiltering (the switch going off) shows every model the catalog names,
   * which is what "show everything" means here.
   */
  const applyFilterByHiding = useCallback(async (
    variant: WorkBuddyCardVariant,
    ids: readonly string[],
  ): Promise<boolean> => {
    const key = keyFor(variant)
    const account = visibilityAccount(variant)
    const catalog = catalogIds(variant)
    if (key === undefined || account === undefined || catalog.length === 0) return false
    const keep = new Set(ids)
    const writes = catalog.map(model => ({ model, visible: keep.has(model) }))
    const results = await Promise.all(writes.map(async write => {
      try {
        const response = await fetch(variant.probePath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
          credentials: 'same-origin',
          body: JSON.stringify({
            action: 'set-model-visibility',
            model: write.model,
            visible: write.visible,
            account,
          }),
        })
        return response.ok
      } catch {
        return false
      }
    }))
    await readAll()
    return results.every(Boolean)
  }, [catalogIds, keyFor, readAll, visibilityAccount])

  /**
   * Write one plugin-wide sidebar preference.
   *
   * An IMMEDIATE write, unlike the model filter beside it: both of these change
   * how an always-visible surface is drawn, and staging them would leave the
   * sidebar keeping a card (or stating the credit one way) while the control
   * claims the other. The value comes back on the next status read, which is
   * what redraws the card.
   *
   * One helper for all three preferences because they are one wire shape — an
   * action plus its value — and because the failure handling is the part that
   * must not drift between them: a 400/404 means this host does not know the
   * action, and that is the same story whichever control asked.
   */
  const writeSidebarPreference = useCallback((
    body: Record<string, unknown>,
    staged: Partial<typeof writtenPreferences>,
  ): void => {
    const variant = CARD_VARIANTS[0]
    const key = variant === undefined ? undefined : keyFor(variant)
    if (variant === undefined || key === undefined) {
      setError(blockedReason(variant ?? CARD_VARIANTS[1] as WorkBuddyCardVariant) ?? t('requestFailed'))
      return
    }
    // Paint the control's own value now. The re-read below is the slow half of
    // this round trip — two status routes, each of which may spend one billing
    // request per account — and a switch that sits still for a second after the
    // click reads as one that did not take. `busy` is deliberately NOT set: it
    // would disable the control for the length of that re-read.
    setWrittenPreferences(current => ({ ...current, ...staged }))
    setError(undefined)
    setNotice(undefined)
    void fetch(variant.probePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          setError(response.status === 400 || response.status === 404
            ? t('sidebarSettingUnsupported')
            : 'HTTP ' + String(response.status))
          // The write did not land, so the painted value is a lie: drop it and
          // let the document's own answer show through again.
          setWrittenPreferences({})
        } else if (typeof value === 'object' && value !== null && 'state' in value && value.state !== 'updated') {
          setError(String((value as Record<string, unknown>)['reason'] ?? t('requestFailed')))
          setWrittenPreferences({})
        }
        // Deliberately NOT readAll() here. The value this write changed is
        // already on screen (staged above), and a full re-read costs two status
        // routes — the international one measured at 1.3s against a live
        // account — for facts this write did not touch. The page's own minute
        // tick still re-reads, so a host that stored something other than what
        // was asked for corrects itself without a click.
        //
        // The sidebar IS told to re-read: it draws from the same documents and
        // the user is looking straight at it.
        refreshPanel?.()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('requestFailed'))
        setWrittenPreferences({})
      })
  }, [blockedReason, keyFor, readAll, refreshPanel, t])

    /**
   * Claim one account's daily check-in now.
   *
   * A write that spends a round trip rather than credit, so it needs the same
   * in-process key as the other actions but no confirmation step: the upstream
   * is idempotent, and re-asking after "already" costs nothing.
   */
  const checkInAccount = useCallback((variant: WorkBuddyCardVariant, accountId: string): void => {
    const key = keyFor(variant)
    if (key === undefined) return
    setBusy(true)
    setError(undefined)
    void fetch(variant.probePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'check-in', account: accountId }),
    })
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          setError('HTTP ' + String(response.status))
        } else if (typeof value === 'object' && value !== null && 'state' in value && value.state === 'failed') {
          setError(String((value as Record<string, unknown>)['reason'] ?? t('requestFailed')))
        }
        // A check-in changes the balance, so the documents are re-read: this is
        // the one write whose point IS the new figures.
        await readAll()
      })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : t('requestFailed')) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }, [keyFor, readAll, t])

  /** Toggle the daily check-in preference. */
  const setCheckinAuto = useCallback((enabled: boolean): void => {
    writeSidebarPreference({ action: 'set-checkin-auto', enabled }, { checkinAuto: enabled })
  }, [writeSidebarPreference])

  /** Store the sidebar's credit-line style. */
  const setCreditStyle = useCallback((style: WorkBuddySidebarCreditStyle): void => {
    writeSidebarPreference({ action: 'set-sidebar-credit-style', creditStyle: style }, { creditStyle: style })
  }, [writeSidebarPreference])

  /**
   * Show or hide the sidebar's credit card.
   *
   * The one preference on this page that removes a surface rather than
   * reshaping it, which is why the group grows a way into the dashboard while it
   * is off: the card is the plugin's only other route there.
   */
  const setCreditVisible = useCallback((visible: boolean): void => {
    writeSidebarPreference({ action: 'set-sidebar-credit-visible', enabled: visible }, { creditVisible: visible })
  }, [writeSidebarPreference])

  /**
   * Show or hide the composer dock's credit badge.
   *
   * A separate switch from the sidebar card above because it removes a different
   * surface in a different place: the two are independent by design, and neither
   * implies the other.
   */
  const setComposerCreditVisible = useCallback((visible: boolean): void => {
    writeSidebarPreference({ action: 'set-composer-credit-visible', enabled: visible }, { composerVisible: visible })
  }, [writeSidebarPreference])

  /**
   * Show or hide the composer's reasoning-detection control.
   *
   * The third composer switch: the badge reports a balance, this control offers
   * to spend credit detecting a model, and the two are separate surfaces a user
   * may want independently.
   */
  const setProbeControlVisible = useCallback((visible: boolean): void => {
    writeSidebarPreference({ action: 'set-probe-control-visible', enabled: visible }, { probeControlVisible: visible })
  }, [writeSidebarPreference])

  /**
   * Write every staged model filter.
   *
   * All-or-nothing in what it REPORTS rather than in what it sends: each
   * product's write goes out on its own (they are independent rows, and one
   * failing must not silently drop the other), and the bar clears only when
   * every write landed — a half-applied save stays visible as unsaved work
   * instead of leaving the page claiming a state the host does not have.
   *
   * `allowlistAction` already surfaces the refusal (HTTP status, host reason,
   * or the "this host does not know the action" copy for a 400/404), which is
   * what the page's error line renders.
   */
  const saveStaged = useCallback((): void => {
    const entries = CARD_VARIANTS.flatMap(variant => {
      const staged = stagedModels[variant.id]
      return staged === undefined ? [] : [{ variant, staged }]
    })
    if (entries.length === 0) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    setJustSaved(false)
    void Promise.all(entries.map(async entry => {
      // Off is written as an empty list: the host reads that as "no filter",
      // which is exactly what the switch being off means.
      const ids = entry.staged.filterOn ? entry.staged.allowlist : []
      const result = await allowlistAction(entry.variant, ids)
      if (result !== 'unsupported') return result === 'updated'
      // The host predates the action. Its hide list can express the same
      // filter, so the switch still works — with a note, because what lands on
      // the host is a translation and an untick is no longer reversible by a
      // re-tick alone.
      const applied = await applyFilterByHiding(entry.variant, ids)
      if (applied) {
        // The "host does not support this" error belonged to the attempt that
        // just succeeded by another route: leaving it up would contradict the
        // note that explains what actually happened.
        setError(undefined)
        setNotice(t('filterModelsFallback'))
      }
      return applied
    }))
      .then(results => {
        if (!mounted.current) return
        if (results.every(Boolean)) {
          setStagedModels({})
          setJustSaved(true)
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('requestFailed'))
      })
      .finally(() => { if (mounted.current) setSaving(false) })
  }, [allowlistAction, applyFilterByHiding, stagedModels, t])

  /**
   * This product's detection state, when the document carries one.
   *
   * Read off the document rather than narrowed through `status`, for the same
   * reason the account section is: `probe` is optional, and a narrowed union
   * loses it.
   */
  const probeFor = useCallback((variant: WorkBuddyCardVariant): WorkBuddyWebProbeSection | undefined => {
    const status = statuses[variant.id]
    return status === undefined || !('probe' in status) ? undefined : status.probe
  }, [statuses])

  /**
   * Every product's accounts in one list, each tagged with its product.
   *
   * Tagged rather than looked up later: a row's controls must post to the route
   * of the pool the account actually lives in, and the only thing that decides
   * that is which status document it came from.
   */
  const taggedAccounts: TaggedAccount[] = CARD_VARIANTS.flatMap(variant => {
    const status = statuses[variant.id]
    if (status === undefined || !('accounts' in status)) return []
    return (status.accounts?.accounts ?? []).map(account => ({ account, variant }))
  })

  /**
   * The check-in section, read from whichever document carries one.
   *
   * Both variants answer with their own section, so the page merges them: the
   * preference is plugin-wide (one clock, one switch) while the rows are per
   * pool — a CN account's claim must never stand in for an international one's.
   */
  const checkinSections = CARD_VARIANTS.flatMap(variant => {
    const status = statuses[variant.id]
    const section = status === undefined || !('checkin' in status) ? undefined : status.checkin
    return section === undefined ? [] : [{ variant, section }]
  })
  /** The plugin-wide switch, when any document states it. */
  const currentCheckinAuto: boolean | undefined =
    writtenPreferences.checkinAuto ?? statedPreference(statuses, status => status.checkinAuto)

  /** Whether anything is waiting to be written; the bar's whole condition. */
  const hasStaged = Object.keys(stagedModels).length > 0

  /**
   * The sidebar style the host reports, when it reports one.
   *
   * Read from whichever document carries it (both variants are told the same
   * value — it is one setting, not a per-product one). Absent on a host that
   * cannot persist the preference, and the row is then not rendered at all: a
   * control that cannot be saved is worse than no control.
   */
  const currentCreditStyle: WorkBuddySidebarCreditStyle | undefined =
    writtenPreferences.creditStyle ?? statedPreference(statuses, status => status.sidebarCreditStyle)

  /**
   * Whether the host says the sidebar keeps its card, when it says anything.
   *
   * `undefined` — not `true` — when no document carries the field: that is an
   * older host which cannot persist the preference, and the switch is then not
   * rendered at all, exactly like the style row beside it. Once the field IS
   * there, an absent value can no longer stand in for "on": the stored value is
   * what the sidebar draws from, and a page that second-guessed it would lie
   * about the state it is editing.
   */
  const currentCreditVisible: boolean | undefined =
    writtenPreferences.creditVisible ?? statedPreference(statuses, status => status.sidebarCreditVisible)

  /**
   * Whether the host says the composer keeps its badge, when it says anything.
   *
   * Same `undefined`-means-older-host reading as the sidebar switch beside it,
   * and the same reason: a control that cannot be saved is worse than no control.
   */
  const currentComposerCreditVisible: boolean | undefined =
    writtenPreferences.composerVisible ?? statedPreference(statuses, status => status.composerCreditVisible)

  /** Whether the host says the composer keeps its detection control. */
  const currentProbeControlVisible: boolean | undefined =
    writtenPreferences.probeControlVisible ?? statedPreference(statuses, status => status.probeControlVisible)

  return (
    // The reference layout: a 720px column of groups of hairline-separated rows.
    // No card surfaces — the page has to read as one of the harness's own
    // settings pages, which are exactly this shape.
    <section className="wbp-section" aria-label={t('accountHeading')}>
      <>
        {/* Accounts first, models below: the pool is short and rarely changed,
            while the model list is the long one a reader scans. */}
        <AccountsSection
          entries={taggedAccounts}
          statuses={statuses}
          busy={busy}
          now={now}
          t={t}
          // One button, and it opens the product picker: which product an
          // account belongs to is the first thing the dialog has to know, and
          // it cannot be inferred from the click.
          onAdd={() => { setError(undefined); setPicking(true) }}
          onAction={accountAction}
          onRefreshAll={refreshAllAccounts}
        />
        <ModelsSection
          variants={CARD_VARIANTS}
          statuses={statuses}
          probeFor={probeFor}
          busy={busy}
          t={t}
          context={context}
          stagedModels={stagedModels}
          onContext={(variant, model, length) => { accountAction(variant, { action: 'context', model, length }) }}
          onRefresh={variant => { refreshModels(variant) }}
          onDetect={(variant, model) => { probeAction(variant, { action: 'probe', model }) }}
          onClearProbe={variant => { probeAction(variant, { action: 'clear' }) }}
          onStage={(variant, next) => { stageModels(variant, next) }}
        />
      </>
      {error === undefined ? null : (
        <p className="wbp-rowError">{error}</p>
      )}
      {notice === undefined ? null : (
        <p className="wbp-notice" role="status">{notice}</p>
      )}
      {/*
        * Every plugin-wide display surface, in one group: the sidebar card and
        * how it states the credit, the composer's credit badge, and the
        * composer's detection control.
        *
        * One group because they are one kind of thing — a surface this plugin
        * draws, which the user may want or not — and each is independent of the
        * others: hiding the badge must not hide the detection control, and
        * turning the sidebar card off says nothing about the composer. Which is
        * why the group is gated on ANY of them being stated rather than on the
        * sidebar's own pair: with three independent preferences, a gate that
        * only looked at two would hide the third's switch behind a host that
        * happened to omit the others.
        *
        * They write IMMEDIATELY, because every one of these surfaces is on
        * screen while its control is being used: staging it would let the
        * sidebar or the composer state one thing while the row claims another.
        *
        * The style row is hidden while the card is off — it would describe a
        * surface that is not there — and on `false` only, never on
        * `undefined`: a host that cannot state the preference is not a host that
        * turned the card off.
        */}
      {/*
        * Check-in: one switch for whether the plugin does it at all, then one
        * row per account stating what the record and the last run say. Kept
        * apart from the display switches above because it is not about how a
        * surface is DRAWN — it spends a request against the user's account.
        */}
      {currentCheckinAuto === undefined && checkinSections.length === 0 ? null : (
        <SettingsGroup title={t('checkinHeading')} description={t('checkinHint')}>
          {currentCheckinAuto === undefined ? null : (
            <SettingRow
              title={t('checkinAutoLabel')}
              titleFor="wbp-checkin-auto"
              description={t('checkinAutoHint')}
              control={(
                <ToggleField
                  id="wbp-checkin-auto"
                  label={t('checkinAutoLabel')}
                  checked={currentCheckinAuto}
                  disabled={busy}
                  onChange={setCheckinAuto}
                />
              )}
            />
          )}
          {checkinSections.flatMap(({ variant, section }) => section.rows.map(row => {
            const account = taggedAccounts.find(entry => entry.variant.id === variant.id && entry.account.id === row.accountId)?.account
            return (
              <SettingRow
                key={`${variant.id}:${row.accountId}`}
                title={account?.name ?? row.accountId}
                description={checkinLine(row, t)}
                control={(
                  <ActionButton
                    label={t('checkinRunNow')}
                    disabled={busy}
                    onClick={() => { checkInAccount(variant, row.accountId) }}
                  />
                )}
              />
            )
          }))}
        </SettingsGroup>
      )}
      {currentCreditVisible === undefined
        && currentCreditStyle === undefined
        && currentComposerCreditVisible === undefined
        && currentProbeControlVisible === undefined
        ? null
        : (
        <SettingsGroup title={t('sidebarStyleHeading')}>
          {currentCreditVisible === undefined ? null : (
            <SettingRow
              title={t('sidebarVisibleLabel')}
              titleFor="wbp-sidebar-visible"
              description={t('sidebarVisibleHint')}
              control={
                <ToggleField
                  id="wbp-sidebar-visible"
                  label={t('sidebarVisibleLabel')}
                  checked={currentCreditVisible}
                  disabled={busy}
                  onChange={setCreditVisible}
                />
              }
            />
          )}
          {currentCreditStyle === undefined || currentCreditVisible === false ? null : (
            <SettingRow
              title={t('sidebarStyleLabel')}
              description={t('sidebarStyleHint')}
              control={
                <SegmentedField
                  label={t('sidebarStyleLabel')}
                  disabled={busy}
                  value={currentCreditStyle}
                  options={[
                    { value: 'remaining', label: t('sidebarStyleRemaining') },
                    { value: 'usage', label: t('sidebarStyleUsage') },
                  ]}
                  onChange={next => {
                    const style = isWorkBuddySidebarCreditStyle(next) ? next : undefined
                    if (style !== undefined && style !== currentCreditStyle) setCreditStyle(style)
                  }}
                />
              }
            />
          )}
          {/*
            * The composer badge switch, beside the sidebar card's own.
            *
            * Two switches rather than one because they remove different surfaces:
            * the card is the sidebar's resident summary, while the badge is the
            * figure in the composer row that also states what the turn cost. The
            * dashboard is reachable through the card alone — the page deliberately
            * carries no second entry (see {@link WorkBuddySettingsPageProps.openPanel}).
            */}
          {currentComposerCreditVisible === undefined ? null : (
            <SettingRow
              title={t('composerVisibleLabel')}
              titleFor="wbp-composer-visible"
              description={t('composerVisibleHint')}
              control={
                <ToggleField
                  id="wbp-composer-visible"
                  label={t('composerVisibleLabel')}
                  checked={currentComposerCreditVisible}
                  disabled={busy}
                  onChange={setComposerCreditVisible}
                />
              }
            />
          )}
          {currentProbeControlVisible === undefined ? null : (
            <SettingRow
              title={t('probeControlVisibleLabel')}
              titleFor="wbp-probe-control-visible"
              description={t('probeControlVisibleHint')}
              control={
                <ToggleField
                  id="wbp-probe-control-visible"
                  label={t('probeControlVisibleLabel')}
                  checked={currentProbeControlVisible}
                  disabled={busy}
                  onChange={setProbeControlVisible}
                />
              }
            />
          )}
        </SettingsGroup>
      )}

      {/*
        * The staged-edit bar — a straight port of the reference implementation's
        * SaveBar (`saveBarView` + `SaveBar` + `useSavedFlash`): a
        * floating capsule pinned to the bottom of the page's scrollport, sliding
        * out of view when there is nothing to save, carrying a tone dot (warn
        * while pending, a tick/error glyph once there is an outcome) and two
        * concentric buttons.
        *
        * It stays MOUNTED and animates, exactly as the reference does: a bar that
        * mounted and unmounted would have nothing to animate out from, and the
        * message it is showing when it goes is the one the user is reading.
        */}
      <div className="wbp-saveBarDock">
        <div
          className={cx(
            'wbp-saveBar',
            error !== undefined ? 'wbp-saveBarError' : justSaved && !hasStaged ? 'wbp-saveBarSuccess' : undefined,
            hasStaged || justSaved || error !== undefined ? 'wbp-saveBarShown' : undefined,
          )}
          role="region"
          aria-label={t('saveBarSave')}
          aria-hidden={!(hasStaged || justSaved || error !== undefined)}
        >
          <span className="wbp-saveBarIcon" aria-hidden="true">
            {!hasStaged && error === undefined
              ? <SaveBarGlyph tone="success" />
              : error !== undefined
                ? <SaveBarGlyph tone="error" />
                : <span className="wbp-saveBarPulse" />}
          </span>
          {/*
            * The bar stays MOUNTED so it can slide out, which means its text is
            * in the DOM while it is hidden. An empty string until there is an
            * outcome: a hidden "Saved" is still read by assistive tech and still
            * found by anything scanning the page's text.
            */}
          <p className="wbp-saveBarText" role="status" aria-live="polite">
            {error !== undefined
              ? error
              : hasStaged
                ? t('saveBarUnsaved')
                : justSaved ? t('saveBarSaved') : ''}
          </p>
          {hasStaged ? (
            <div className="wbp-saveBarActions">
              {/* Own buttons rather than the panel's: they are sized to sit
                  concentrically inside the bar's 44px capsule. */}
              <button
                type="button"
                className="wbp-saveBarButton wbp-saveBarGhost"
                disabled={saving}
                onClick={() => { discardStaged() }}
              >
                {t('saveBarDiscard')}
              </button>
              <button
                type="button"
                className="wbp-saveBarButton wbp-saveBarPrimary"
                disabled={saving}
                onClick={() => { saveStaged() }}
              >
                {t(saving ? 'saveBarSaving' : 'saveBarSave')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {picking
        ? <ProductPicker t={t} onPick={picked => { setPicking(false); setAdding(picked) }} onCancel={() => { setPicking(false) }} />
        : null}
      {adding === undefined ? null : (
        <AddAccountDialog
          variant={adding}
          t={t}
          busy={busy}
          {...error === undefined ? {} : { error }}
          onCancel={() => { setAdding(undefined); setError(undefined) }}
          onSubmitQr={() => submitQr(adding)}
          onPollQr={state => pollQr(adding, state)}
          onSubmitToken={token => submitToken(adding, token)}
          onSubmitDesktop={() => submitDesktop(adding)}
          onOpenLink={url => openSignInPage(adding, url)}
        />
      )}
    </section>
  )
}
