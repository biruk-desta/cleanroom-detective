// The audit engine uses the same small synchronous interface in Node and WASM.
// Bounded statement caching avoids both prepare-per-row cost and WASM leaks.
export function wrapSqlite(sqlite3, database) {
  const cache = new Map();
  function prepare(sql) {
    let entry = cache.get(sql);
    if (entry && !entry.busy) {
      cache.delete(sql);
      cache.set(sql, entry);
      return entry.api;
    }
    if (entry?.busy)
      throw new Error('A database cursor is already using this query.');
    if (cache.size >= 128) {
      for (const [key, candidate] of cache) {
        if (!candidate.busy) {
          candidate.statement.finalize();
          cache.delete(key);
          break;
        }
      }
    }
    const statement = database.prepare(sql);
    entry = { statement, busy: false, api: null };
    const start = (args) => {
      entry.busy = true;
      if (args.length) statement.bind(args);
    };
    const stop = () => {
      try {
        statement.reset(true);
      } catch {
        /* reset can repeat an already-reported step error; it still resets the VM. */
      } finally {
        entry.busy = false;
      }
    };
    entry.api = {
      run(...args) {
        try {
          start(args);
          statement.step();
          return { changes: database.changes() };
        } finally {
          stop();
        }
      },
      get(...args) {
        try {
          start(args);
          return statement.step() ? statement.get({}) : undefined;
        } finally {
          stop();
        }
      },
      all(...args) {
        const rows = [];
        try {
          start(args);
          while (statement.step()) rows.push(statement.get({}));
          return rows;
        } finally {
          stop();
        }
      },
      *iterate(...args) {
        try {
          start(args);
          while (statement.step()) yield statement.get({});
        } finally {
          stop();
        }
      },
    };
    cache.set(sql, entry);
    return entry.api;
  }
  return {
    prepare,
    exec(sql) {
      database.exec(sql);
    },
    get isTransaction() {
      return !sqlite3.capi.sqlite3_get_autocommit(database.pointer);
    },
    close() {
      for (const entry of cache.values()) entry.statement.finalize();
      cache.clear();
      database.close();
    },
  };
}
