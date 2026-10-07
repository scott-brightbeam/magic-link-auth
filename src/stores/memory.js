// In-memory store — tests and local development only. State is lost on restart
// and is not shared between processes, so never use it behind more than one instance.

export function memoryStore() {
  const tokens = new Map() // hash → record
  const hits = new Map()   // key → number[] (ms timestamps)

  return {
    kind: 'memory',
    async init() {},

    async insertToken(rec) {
      tokens.set(rec.hash, { ...rec, usedAt: null, supersededAt: null })
    },

    async supersede(email, now) {
      for (const rec of tokens.values()) {
        if (rec.email === email && rec.usedAt == null && rec.supersededAt == null) rec.supersededAt = now
      }
    },

    async getToken(hash) {
      const rec = tokens.get(hash)
      return rec ? { ...rec } : null
    },

    // Single-use: succeeds for exactly one caller. JS is single-threaded, so the
    // check-and-set below is atomic with respect to other awaits.
    async consumeToken(hash, now) {
      const rec = tokens.get(hash)
      if (!rec || rec.usedAt != null || rec.supersededAt != null || rec.expiresAt <= now) return false
      rec.usedAt = now
      return true
    },

    async hit(key, now, windowMs) {
      const list = (hits.get(key) ?? []).filter(t => t > now - windowMs)
      list.push(now)
      hits.set(key, list)
      return list.length
    },

    async purge(now) {
      for (const [h, rec] of tokens) if (rec.expiresAt <= now) tokens.delete(h)
    },

    /** Test hook: everything the store holds, for leak assertions. */
    dump() {
      return JSON.stringify({ tokens: [...tokens.entries()], hits: [...hits.entries()] })
    },
  }
}
