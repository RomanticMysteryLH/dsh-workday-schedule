/**
 * Durable task store: one JSON document per profile, written atomically.
 * @module dsh-workday-schedule/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Current on-disk document version. */
const VERSION = 1

/** Tasks for this plugin, keyed by a stable plugin-local id. */
export class TaskStore {
  /** @param {{dataDir: string}} options Wiring. */
  constructor(options) {
    this.path = join(options.dataDir, 'tasks.json')
    this.tasks = []
  }

  /** @returns {Promise<void>} */
  async load() {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {})
    try {
      const doc = JSON.parse(await readFile(this.path, 'utf8'))
      this.tasks = Array.isArray(doc?.tasks) ? doc.tasks : []
    } catch {
      this.tasks = []
    }
  }

  /** @returns {Promise<void>} */
  async save() {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {})
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, JSON.stringify({ version: VERSION, tasks: this.tasks }, null, 2), 'utf8')
    await rename(tmp, this.path)
  }

  /**
   * @param {Omit<any, 'id' | 'createdAt' | 'updatedAt'>} task New task fields.
   * @returns {any} Stored task.
   */
  add(task) {
    const now = Date.now()
    const stored = { id: `wds-${randomUUID()}`, createdAt: now, updatedAt: now, ...task }
    this.tasks.push(stored)
    return stored
  }

  /** @param {string} id Task id. @returns {any | undefined} */
  get(id) { return this.tasks.find(t => t.id === id) }

  /**
   * @param {string} id Task id.
   * @param {Record<string, unknown>} patch Fields to replace.
   * @returns {any | undefined} Updated task.
   */
  update(id, patch) {
    const task = this.get(id)
    if (task === undefined) return undefined
    Object.assign(task, patch, { updatedAt: Date.now() })
    return task
  }

  /** @param {string} id Task id. @returns {boolean} Whether a task was removed. */
  remove(id) {
    const before = this.tasks.length
    this.tasks = this.tasks.filter(t => t.id !== id)
    return this.tasks.length !== before
  }
}
