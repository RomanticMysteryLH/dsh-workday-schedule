/**
 * Client-callable contract for the automation page.
 *
 * The page needs data the browser cannot derive: statutory holidays, 调休 make-up
 * workdays, and the rule verdict for every task on every day. Rather than duplicating
 * the calendar in the client, the Host exposes a small method set, so the page and the
 * agent tools read the same computation.
 *
 * Writes go through this service as well: a composable rule cannot survive the
 * title-suffix channel that carried the three simple modes, so the Host owns the rule.
 * @module dsh-workday-schedule/remote
 */

/** Package identity shared by the Host registration and the Client mount. */
export const PACKAGE = 'dsh-workday-schedule'

/** Service name the descriptors resolve against. */
export const SERVICE = 'workdaySchedule'

/**
 * Pass-through JSON codec.
 * @param {string} name Codec identity.
 * @returns {any}
 */
function codec(name) {
  return { mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse: value => value }) }
}

const requestCodec = codec('Request')

/**
 * Build one invocation descriptor.
 * @param {string} method Service method name.
 * @returns {any}
 */
function descriptor(method) {
  return {
    id: `${PACKAGE}#${SERVICE}/${method}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    result: codec('Result'),
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
  }
}

/**
 * Invocation descriptors.
 *
 * `plan` reads the page feed, `previewRule` lets the builder show real dates before
 * saving, and `createTask` / `updateTask` / `deleteTask` write tasks the page builds.
 */
export const PLAN_DESCRIPTORS = Object.freeze([
  descriptor('plan'),
  descriptor('previewRule'),
  descriptor('createTask'),
  descriptor('updateTask'),
  descriptor('deleteTask'),
])

/** The object both halves mount. */
export const PLAN_REMOTE = Object.freeze({ package: PACKAGE, descriptors: PLAN_DESCRIPTORS })

/** Empty typert model: this contract declares invocations only. */
export const PLAN_MODEL = Object.freeze({ services: [], events: [], objects: [] })
