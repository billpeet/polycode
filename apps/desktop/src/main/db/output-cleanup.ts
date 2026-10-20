import type Database from 'better-sqlite3'

/**
 * One-time cleanup of Codex command output saved before the session stopped saving
 * output deltas (see `OutputEvent.transient`).
 *
 * Every delta used to be its own row, repeating the delta in its metadata, and the
 * command's final result repeated the whole output as `aggregated_output`. A real
 * 3.2 GB database held 1.8M delta rows (about 1.2 GB) and 178 MB of
 * `aggregated_output`.
 *
 * For each command it keeps one row holding the longer of the final result and the
 * joined deltas, the rule the session now applies live. Transcripts lose nothing; a
 * trial on that database found they change only where the old fold had shown a
 * command's output twice (streamed text, then the final result appended), had hidden
 * it behind a later empty result, or had split streamed text around another command's
 * delta rows.
 *
 * The work runs on the main process in steps of a few milliseconds each
 * (`OutputCleanup.step`). The largest command seen was 10,002 rows, so a command is
 * processed across many steps; every intermediate state still reads correctly. Only
 * `cursor` is saved: after a restart the command in progress is simply read again.
 */

export interface OutputCleanupState {
  /** Rowids below this are clean. */
  cursor: number
  /** Rowids from here up were written after the cleanup began, by code that saves no deltas. */
  end: number
  deletedRows: number
  done: boolean
}

const IS_DELTA = `instr(metadata, '"delta"') > 0
  AND json_extract(metadata, '$.type') = 'tool_result'
  AND json_extract(metadata, '$.delta') IS NOT NULL`

/** Rows examined when looking for the next command, per unit of work. */
const SEARCH_ROWS = 200
/** Rows read forward through a command's output, per unit of work. */
const SCAN_ROWS = 250
/**
 * Rows deleted, or whose content is read, per unit of work, and at most this many
 * characters of them: freeing or reading a large row's overflow pages is what makes
 * a unit slow (a trial saw 250-row deletes take up to 1.1s).
 */
const ROW_CHUNK = 250
const CHAR_CHUNK = 1_000_000
/**
 * Largest output joined into one row. Writing one huge row is a single statement that
 * cannot be split into steps (a 76 MB `rg` run took 9.5s); such commands are left as
 * they are. Paging already trims them, and no client shows that much text whole.
 */
const JOIN_LIMIT = 5_000_000

interface GroupStart {
  seq: number
  thread_id: string
  created_at: string
  tool_use_id: string | null
}

interface ScannedRow {
  seq: number
  created_at: string
  role: string
  len: number
  metadata: string | null
}

/** One command's output, being collapsed into one row. */
interface Job {
  start: GroupStart
  phase: 'scan' | 'join' | 'delete'
  /** Next row to read forward from while scanning; the first read includes it. */
  from: { createdAt: string; seq: number; inclusive: boolean }
  deltas: number[]
  /** Content length of each delta, by index. */
  deltaLens: number[]
  deltaChars: number
  final: { seq: number; chars: number } | null
  /** Content read so far in the join phase. */
  pieces: string[]
  /** Indexes into `deltas` still to delete; taken from the end, so the rows left are always a prefix. */
  doomed: number[]
}

function groupKey(start: GroupStart): string {
  return `${start.thread_id}\u0000${start.tool_use_id ?? ''}`
}

/** The last items of `indexes` that fit in one unit of work: at least one. */
function takeChunk(indexes: number[], lens: number[]): number[] {
  let count = 0
  let chars = 0
  while (count < indexes.length && count < ROW_CHUNK) {
    const len = lens[indexes[indexes.length - 1 - count]]
    if (count > 0 && chars + len > CHAR_CHUNK) break
    chars += len
    count += 1
  }
  return indexes.splice(indexes.length - count)
}

export class OutputCleanup {
  private job: Job | null = null
  /** Commands left as they are (`JOIN_LIMIT`), so their later delta rows are passed over at once. */
  private readonly skipped = new Set<string>()

  constructor(
    private readonly db: Database.Database,
    private state: OutputCleanupState,
  ) {}

  static begin(db: Database.Database): OutputCleanupState {
    const max = (db.prepare('SELECT MAX(rowid) AS max FROM messages').get() as { max: number | null }).max ?? 0
    return { cursor: 0, end: max + 1, deletedRows: 0, done: max === 0 }
  }

  get current(): OutputCleanupState {
    return this.state
  }

  /** Work for about `budgetMs`, in units of a few milliseconds each; always at least one. */
  step(budgetMs: number): OutputCleanupState {
    const deadline = performance.now() + budgetMs
    do {
      if (this.state.done) break
      this.unit()
    } while (performance.now() < deadline)
    return this.state
  }

  /** Run to the end (tests, and the trial against a copy of a real database). */
  runToEnd(): OutputCleanupState {
    while (!this.state.done) this.unit()
    return this.state
  }

  private unit(): void {
    if (!this.job) this.findNextGroup()
    else if (this.job.phase === 'scan') this.scan(this.job)
    else if (this.job.phase === 'join') this.join(this.job)
    else this.deleteSome(this.job)
  }

  private findNextGroup(): void {
    const { cursor, end } = this.state
    const to = Math.min(cursor + SEARCH_ROWS, end)
    const start = this.db
      .prepare(
        `SELECT rowid AS seq, thread_id, created_at, json_extract(metadata, '$.tool_use_id') AS tool_use_id
         FROM messages WHERE rowid >= ? AND rowid < ? AND ${IS_DELTA} ORDER BY rowid LIMIT 1`
      )
      .get(cursor, to) as GroupStart | undefined
    const cleanTo = start ? start.seq : to
    this.dropAggregatedOutput(cursor, cleanTo)
    this.advance(cleanTo)
    if (start && this.skipped.has(groupKey(start))) {
      this.advance(start.seq + 1)
      return
    }
    if (start) {
      this.job = {
        start,
        phase: 'scan',
        from: { createdAt: start.created_at, seq: start.seq, inclusive: true },
        deltas: [],
        deltaLens: [],
        deltaChars: 0,
        final: null,
        pieces: [],
        doomed: [],
      }
    }
  }

  /** The final result's text is the output; the copy in its metadata is never read. */
  private dropAggregatedOutput(from: number, to: number): void {
    if (to <= from) return
    this.db.prepare(
      `UPDATE messages SET metadata = json_remove(metadata, '$.aggregated_output')
       WHERE rowid >= ? AND rowid < ? AND instr(metadata, '"aggregated_output"') > 0
         AND json_extract(metadata, '$.type') = 'tool_result'`
    ).run(from, to)
  }

  private advance(cursor: number): void {
    this.state = { ...this.state, cursor, done: cursor >= this.state.end }
  }

  /**
   * Read forward from the command's first delta for its other deltas and its final
   * result. A user message ends the search: the final result arrives within the Turn.
   */
  private scan(job: Job): void {
    const { from } = job
    const rows = this.db
      .prepare(
        `SELECT rowid AS seq, created_at, role, length(content) AS len, metadata FROM messages
         WHERE thread_id = ? AND created_at >= ? AND (created_at > ? OR rowid ${from.inclusive ? '>=' : '>'} ?)
         ORDER BY created_at ASC, rowid ASC LIMIT ?`
      )
      .all(job.start.thread_id, from.createdAt, from.createdAt, from.seq, SCAN_ROWS) as ScannedRow[]
    const toolUseId = job.start.tool_use_id
    for (const row of rows) {
      if (row.role === 'user') return this.resolve(job)
      if (!row.metadata || (toolUseId && !row.metadata.includes(toolUseId))) continue
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(row.metadata) as Record<string, unknown>
      } catch {
        continue
      }
      if (meta.type !== 'tool_result' || (meta.tool_use_id ?? null) !== toolUseId) continue
      if (meta.delta !== undefined) {
        job.deltas.push(row.seq)
        job.deltaLens.push(row.len)
        job.deltaChars += row.len
        continue
      }
      job.final = { seq: row.seq, chars: row.len }
      return this.resolve(job)
    }
    if (rows.length < SCAN_ROWS) return this.resolve(job)
    const last = rows[rows.length - 1]
    job.from = { createdAt: last.created_at, seq: last.seq, inclusive: false }
  }

  private resolve(job: Job): void {
    const needsJoin = !job.final || job.final.chars < job.deltaChars
    if (needsJoin && job.deltaChars > JOIN_LIMIT) {
      this.skipped.add(groupKey(job.start))
      this.job = null
      this.advance(job.start.seq + 1)
      return
    }
    if (job.final && job.final.chars >= job.deltaChars) {
      job.phase = 'delete'
      job.doomed = job.deltas.map((_, index) => index)
    } else {
      // The streamed pieces hold more than the final result, or there is none: they
      // are what the transcript showed, so they become the record.
      job.phase = 'join'
    }
  }

  private join(job: Job): void {
    if (job.pieces.length < job.deltas.length) {
      const read = this.db.prepare('SELECT content FROM messages WHERE rowid = ?')
      let chars = 0
      while (job.pieces.length < job.deltas.length && (chars === 0 || chars < CHAR_CHUNK)) {
        const index = job.pieces.length
        job.pieces.push((read.get(job.deltas[index]) as { content: string } | undefined)?.content ?? '')
        chars += job.deltaLens[index] + 1
      }
      return
    }
    const content = job.pieces.join('')
    job.pieces = []
    if (job.final) {
      this.db.prepare('UPDATE messages SET content = ? WHERE rowid = ?').run(content, job.final.seq)
      job.doomed = job.deltas.map((_, index) => index)
    } else {
      // Keep the last delta, after the rest: if the cleanup restarts midway, a scan
      // from the first remaining delta finds it as the command's final result.
      const keep = job.deltas[job.deltas.length - 1]
      const metadata = JSON.stringify({ type: 'tool_result', ...(job.start.tool_use_id ? { tool_use_id: job.start.tool_use_id } : {}) })
      this.db.prepare('UPDATE messages SET content = ?, metadata = ? WHERE rowid = ?').run(content, metadata, keep)
      job.doomed = job.deltas.slice(0, -1).map((_, index) => index)
    }
    job.phase = 'delete'
  }

  private deleteSome(job: Job): void {
    const chunk = takeChunk(job.doomed, job.deltaLens).map((index) => job.deltas[index])
    if (chunk.length > 0) {
      this.db.prepare(`DELETE FROM messages WHERE rowid IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
      this.state = { ...this.state, deletedRows: this.state.deletedRows + chunk.length }
    }
    if (job.doomed.length > 0) return
    this.job = null
    // Rows between the command's first delta and here may start other commands.
    this.advance(job.start.seq + 1)
  }
}
