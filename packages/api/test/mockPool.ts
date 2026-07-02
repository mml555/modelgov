/**
 * Minimal Postgres mock for unit tests that exercise chat audit logging.
 * Returns `req_1` (etc.) when `INSERT INTO request_logs` runs.
 */
export function mockPool(auditLogId = 1) {
  return {
    query: async (sql: string) => {
      if (sql.includes("INSERT INTO request_logs")) {
        return { rows: [{ id: String(auditLogId) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 1 }),
      release: () => {},
    }),
  };
}
