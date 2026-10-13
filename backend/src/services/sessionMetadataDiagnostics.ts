/**
 * Local-only diagnostics for the small session-level JSON document.  Keep this
 * separate from interaction-log metadata: it never emits transcript/chat text
 * or the full JSON document.
 */
// LOCAL DIAGNOSTICS ONLY — set TIMELINE_DIAGNOSTICS=false before pushing/deploying.
// This must be a function rather than a module-level constant: index.ts loads
// dotenv after route modules are imported, so a constant would capture `false`
// before .env has been read.
export function sessionMetadataDiagnosticsEnabled(): boolean {
  return process.env.TIMELINE_DIAGNOSTICS === 'true';
}

type SqlExecutor = {
  execute: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
};

function errorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const mysqlError = error as Error & { code?: unknown; errno?: unknown; sqlState?: unknown; sqlMessage?: unknown };
  return {
    name: mysqlError.name,
    message: mysqlError.message,
    code: mysqlError.code,
    errno: mysqlError.errno,
    sqlState: mysqlError.sqlState,
    sqlMessage: mysqlError.sqlMessage,
  };
}

/**
 * Inspect the value inside MySQL instead of selecting `metadata` itself.  A
 * direct SELECT can make mysql2 parse an invalid/empty JSON payload before the
 * application gets a chance to log useful context.
 */
export async function inspectSessionMetadata(db: SqlExecutor, sessionId: string): Promise<Record<string, unknown>> {
  if (!sessionMetadataDiagnosticsEnabled()) return {};

  const result: Record<string, unknown> = {};
  try {
    const [rows] = await db.execute(
      `SELECT metadata IS NULL AS is_sql_null,
              OCTET_LENGTH(metadata) AS metadata_bytes,
              CHAR_LENGTH(CAST(metadata AS CHAR)) AS metadata_characters,
              SHA2(COALESCE(CAST(metadata AS CHAR), '<SQL NULL>'), 256) AS metadata_sha256
       FROM sessions WHERE id = ?`,
      [sessionId]
    );
    result.storage = (rows as Record<string, unknown>[])[0] ?? { sessionFound: false };
  } catch (error) {
    result.storageInspectionError = errorSummary(error);
    return result;
  }

  // Deliberately separate JSON inspection from storage inspection.  This tells
  // us whether JSON functions themselves fail (e.g. packet overflow) while
  // retaining the pre-failure size/hash snapshot above.
  try {
    const [rows] = await db.execute(
      `SELECT JSON_VALID(metadata) AS json_valid,
              JSON_TYPE(metadata) AS json_type,
              JSON_CONTAINS_PATH(metadata, 'one', '$.sessionStartEpochMs') AS has_session_start,
              JSON_CONTAINS_PATH(metadata, 'one', '$.recordingStartEpochMs') AS has_recording_start,
              JSON_TYPE(JSON_EXTRACT(metadata, '$.sessionStartEpochMs')) AS session_start_value_type,
              CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.sessionStartEpochMs'))) AS session_start_value_characters,
              LEFT(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.sessionStartEpochMs')), 64) AS session_start_value_preview,
              SHA2(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.sessionStartEpochMs')), 256) AS session_start_value_sha256,
              JSON_TYPE(JSON_EXTRACT(metadata, '$.recordingStartEpochMs')) AS recording_start_value_type,
              CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.recordingStartEpochMs'))) AS recording_start_value_characters,
              LEFT(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.recordingStartEpochMs')), 64) AS recording_start_value_preview,
              SHA2(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.recordingStartEpochMs')), 256) AS recording_start_value_sha256
       FROM sessions WHERE id = ?`,
      [sessionId]
    );
    result.json = (rows as Record<string, unknown>[])[0] ?? { sessionFound: false };
  } catch (error) {
    result.jsonInspectionError = errorSummary(error);
  }
  return result;
}

export function sessionMetadataDiagnostic(payload: Record<string, unknown>): void {
  if (!sessionMetadataDiagnosticsEnabled()) return;
  console.info('[SESSION_METADATA_DIAGNOSTIC]', JSON.stringify({ at: new Date().toISOString(), ...payload }));
}

export function sessionMetadataErrorSummary(error: unknown): Record<string, unknown> {
  return errorSummary(error);
}
