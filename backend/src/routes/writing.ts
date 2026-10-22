import express from 'express';
import mysql from 'mysql2/promise';

const router = express.Router();

// Auto-save writing content
router.post('/save', async (req, res) => {
  const db: mysql.Connection = (req as any).db;

  try {
    const {
      sessionId,
      content,
      wordCount,
      charCount,
      timestamp
    } = req.body;

    if (!db) {
      console.log('Demo mode: Auto-save received but not saved to database');
      return res.json({
        success: true,
        message: 'Auto-save received (demo mode)',
        timestamp
      });
    }

    // Check if writing record exists for this session
    const [existingWriting] = await db.execute(
      'SELECT id FROM writing_drafts WHERE session_id = ?',
      [sessionId]
    );

    const mysqlTimestamp = new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

    if ((existingWriting as any[]).length > 0) {
      // Update existing draft
      await db.execute(
        `UPDATE writing_drafts
         SET content = ?, word_count = ?, char_count = ?, last_saved_at = ?
         WHERE session_id = ?`,
        [content, wordCount, charCount, mysqlTimestamp, sessionId]
      );
    } else {
      // Insert new draft
      await db.execute(
        `INSERT INTO writing_drafts (session_id, content, word_count, char_count, last_saved_at)
         VALUES (?, ?, ?, ?, ?)`,
        [sessionId, content, wordCount, charCount, mysqlTimestamp]
      );
    }

    // Keep a bounded, append-only window for guidance context. The client already
    // autosaves at most once per three seconds; unchanged writing never creates a row.
    const [latestRows] = await db.execute(
      'SELECT id, content FROM writing_snapshots WHERE session_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1',
      [sessionId]
    );
    const latest = (latestRows as any[])[0];
    if (!latest || String(latest.content) !== String(content ?? '')) {
      await db.execute(
        'INSERT INTO writing_snapshots (session_id, content, captured_at) VALUES (?, ?, ?)',
        [sessionId, content ?? '', mysqlTimestamp]
      );
      // Trim from the oldest side only when the retained range reaches 60 seconds.
      // Rechecking supports a delayed autosave that crosses more than one interval.
      while (true) {
        const [boundsRows] = await db.execute(
          'SELECT id, captured_at FROM writing_snapshots WHERE session_id = ? ORDER BY captured_at ASC, id ASC',
          [sessionId]
        );
        const snapshots = boundsRows as any[];
        if (snapshots.length < 2) break;
        const earliest = snapshots[0];
        const newest = snapshots[snapshots.length - 1];
        if (new Date(newest.captured_at).getTime() - new Date(earliest.captured_at).getTime() < 60_000) break;
        await db.execute('DELETE FROM writing_snapshots WHERE id = ?', [earliest.id]);
      }
    }

    res.json({
      success: true,
      message: 'Auto-save successful',
      timestamp
    });
  } catch (error) {
    console.error('Error auto-saving writing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to auto-save writing',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get writing draft by session ID
router.get('/:sessionId', async (req, res) => {
  const db: mysql.Connection = (req as any).db;
  const { sessionId } = req.params;

  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available (demo mode)' });
    }

    const [drafts] = await db.execute(
      'SELECT * FROM writing_drafts WHERE session_id = ? ORDER BY last_saved_at DESC LIMIT 1',
      [sessionId]
    );

    if ((drafts as any[]).length === 0) {
      return res.json({ content: '', wordCount: 0, charCount: 0 });
    }

    res.json({ draft: (drafts as any[])[0] });
  } catch (error) {
    console.error('Error fetching writing draft:', error);
    res.status(500).json({ error: 'Failed to fetch writing draft' });
  }
});

export default router;
