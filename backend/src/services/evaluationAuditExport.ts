import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

type SqlExecutor = Pick<mysql.Pool, 'execute'>;

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function jsonBlock(value: unknown): string {
  return `~~~json\n${JSON.stringify(value, null, 2)}\n~~~`;
}

function formatAuditMarkdown(sessionId: string, rows: any[]): string {
  const lines = [
    '# Evaluation Agent Audit',
    '',
    `- Session: \`${sessionId}\``,
    `- Exported at: ${new Date().toISOString()}`,
    `- Evaluation runs: ${rows.length}`,
    '',
  ];

  for (const row of rows) {
    const evaluationInput = parsePayload(row.evaluation_input_payload);
    const evaluationOutput = parsePayload(row.evaluation_output_payload);
    const controllerInput = parsePayload(row.controller_input_payload);
    const controllerOutput = parsePayload(row.controller_output_payload);
    const ledgerDelta = parsePayload(row.move_ledger_delta);
    const guidanceGeneration = parsePayload(row.guidance_generation_payload);
    const aiGuidance = evaluationOutput && typeof evaluationOutput === 'object'
      ? (evaluationOutput as Record<string, unknown>).aiGuidance ?? null
      : null;
    lines.push(
      `## Evaluation #${row.id} · controller turn ${row.turn_index}`,
      '',
      `- Trigger: **${row.trigger_type}** — ${row.trigger_reason || 'No reason recorded.'}`,
      `- Evaluation: ${row.evaluation_started_at} → ${row.evaluation_completed_at} (${row.evaluation_duration_ms} ms), status: **${row.evaluation_status}**, model: ${row.evaluation_model_used || 'n/a'}, retries: ${row.evaluation_retry_count}`,
      `- Controller: ${row.controller_status}; ${row.controller_started_at || 'not run'} → ${row.controller_completed_at || 'n/a'}${row.controller_duration_ms == null ? '' : ` (${row.controller_duration_ms} ms)`}`,
      `- Controller turn count: ${row.controller_turn_count_before ?? 'n/a'} → ${row.controller_turn_count_after ?? 'n/a'}`,
      `- Move ledger count: ${row.move_ledger_count_before} → ${row.move_ledger_count_after}`,
      `- Streak: ${row.streak_orientation_before || 'none'} × ${row.streak_count_before ?? 0} (suppression ${row.streak_suppression_remaining_before ?? 0}) → ${row.streak_orientation_after || 'none'} × ${row.streak_count_after ?? 0} (suppression ${row.streak_suppression_remaining_after ?? 0})`,
      '',
      '### Evaluation input',
      '',
      jsonBlock(evaluationInput),
      '',
      '### Evaluation output',
      '',
      jsonBlock(evaluationOutput),
      '',
      '### Controller input and output',
      '',
      jsonBlock({ input: controllerInput, output: controllerOutput, error: row.controller_error_message || null }),
      '',
      '### AI-guidance decision',
      '',
      jsonBlock(aiGuidance),
      '',
      '### Guidance-generation bundle',
      '',
      jsonBlock(guidanceGeneration),
      '',
      '### Move-ledger delta for this evaluation',
      '',
      jsonBlock(ledgerDelta),
      '',
    );
  }
  return lines.join('\n');
}

/** Export the dedicated evaluation_agent_audit table without reconstructing data from other tables. */
export async function exportEvaluationAudit(db: SqlExecutor, sessionId: string): Promise<{
  jsonFileUrl: string;
  markdownFileUrl: string;
  count: number;
}> {
  const [queryRows] = await db.execute(
    'SELECT * FROM evaluation_agent_audit WHERE session_id = ? ORDER BY id ASC',
    [sessionId]
  );
  const rows = (queryRows as any[]).map((row) => ({
    ...row,
    evaluation_input_payload: parsePayload(row.evaluation_input_payload),
    evaluation_output_payload: parsePayload(row.evaluation_output_payload),
    controller_input_payload: parsePayload(row.controller_input_payload),
    controller_output_payload: parsePayload(row.controller_output_payload),
    move_ledger_delta: parsePayload(row.move_ledger_delta),
    guidance_generation_payload: parsePayload(row.guidance_generation_payload),
  }));
  const exportedAt = new Date().toISOString();
  const json = {
    schemaVersion: 1,
    sessionId,
    exportedAt,
    evaluationRuns: rows,
  };

  const exportDir = path.join(__dirname, '../../uploads/evaluation_audits');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const jsonFilename = `evaluation_audit_${sessionId}.json`;
  const markdownFilename = `evaluation_audit_${sessionId}.md`;
  fs.writeFileSync(path.join(exportDir, jsonFilename), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(exportDir, markdownFilename), formatAuditMarkdown(sessionId, rows));

  return {
    jsonFileUrl: `/uploads/evaluation_audits/${jsonFilename}`,
    markdownFileUrl: `/uploads/evaluation_audits/${markdownFilename}`,
    count: rows.length,
  };
}
