// libSQL / Turso / SQLite store. Takes any client exposing
// `execute({ sql, args }) → { rows, rowsAffected }` — the @libsql/client API.
// Tables are created on init() and namespaced by `tablePrefix`.

export function libsqlStore(client, { tablePrefix = 'magic_link_' } = {}) {
  if (!client || typeof client.execute !== 'function') {
    throw new Error('libsqlStore: a client with execute({ sql, args }) is required')
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(tablePrefix)) throw new Error('libsqlStore: tablePrefix must be an identifier')
  const T = `${tablePrefix}tokens`
  const H = `${tablePrefix}hits`
  let ready = null

  const exec = (sql, args = []) => client.execute({ sql, args })

  async function init() {
    ready ??= (async () => {
      await exec(`CREATE TABLE IF NOT EXISTS ${T} (
        hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        superseded_at INTEGER,
        requester_hash TEXT
      )`)
      await exec(`CREATE INDEX IF NOT EXISTS idx_${T}_email ON ${T}(email)`)
      await exec(`CREATE TABLE IF NOT EXISTS ${H} (key TEXT NOT NULL, at INTEGER NOT NULL)`)
      await exec(`CREATE INDEX IF NOT EXISTS idx_${H}_key_at ON ${H}(key, at)`)
    })()
    return ready
  }

  const row = r => r && ({
    hash: r.hash, email: r.email, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
    usedAt: r.used_at == null ? null : Number(r.used_at),
    supersededAt: r.superseded_at == null ? null : Number(r.superseded_at),
    requesterHash: r.requester_hash ?? null,
  })

  return {
    kind: 'libsql',
    init,

    async insertToken(rec) {
      await init()
      await exec(`INSERT INTO ${T} (hash, email, created_at, expires_at, requester_hash) VALUES (?, ?, ?, ?, ?)`,
        [rec.hash, rec.email, rec.createdAt, rec.expiresAt, rec.requesterHash ?? null])
    },

    async supersede(email, now) {
      await init()
      await exec(`UPDATE ${T} SET superseded_at = ? WHERE email = ? AND used_at IS NULL AND superseded_at IS NULL`, [now, email])
    },

    async getToken(hash) {
      await init()
      const { rows } = await exec(`SELECT * FROM ${T} WHERE hash = ?`, [hash])
      return row(rows[0]) ?? null
    },

    // One conditional UPDATE: two racing redeems cannot both see rowsAffected = 1.
    async consumeToken(hash, now) {
      await init()
      const r = await exec(
        `UPDATE ${T} SET used_at = ? WHERE hash = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?`,
        [now, hash, now])
      return Number(r.rowsAffected) === 1
    },

    async hit(key, now, windowMs) {
      await init()
      await exec(`INSERT INTO ${H} (key, at) VALUES (?, ?)`, [key, now])
      const { rows } = await exec(`SELECT COUNT(*) AS n FROM ${H} WHERE key = ? AND at > ?`, [key, now - windowMs])
      return Number(rows[0].n)
    },

    async purge(now, { keepMs = 7 * 24 * 3600 * 1000 } = {}) {
      await init()
      await exec(`DELETE FROM ${T} WHERE expires_at < ?`, [now - keepMs])
      await exec(`DELETE FROM ${H} WHERE at < ?`, [now - keepMs])
    },
  }
}
