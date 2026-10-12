#!/usr/bin/env python3
"""
Download all final written proposals from the research platform database.
Exports to both JSON and individual text files.
"""

import mysql.connector
import json
import os
from datetime import datetime
from pathlib import Path

# Database configuration (from .env and docker-compose.yml)
DB_CONFIG = {
    'host': 'localhost',  # Docker exposes MySQL on localhost:3306
    'port': 3306,
    'user': 'research_user',
    'password': 'securePassword2025',
    'database': 'research_platform'
}

# Output directory
OUTPUT_DIR = 'downloaded_proposals'
os.makedirs(OUTPUT_DIR, exist_ok=True)

def connect_to_db():
    """Connect to the MySQL database"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        print(f"✅ Connected to database: {DB_CONFIG['database']}")
        return conn
    except mysql.connector.Error as err:
        print(f"❌ Database connection failed: {err}")
        print(f"\nMake sure Docker containers are running:")
        print(f"  cd /Users/yanliu/claude/research-platform")
        print(f"  docker-compose ps")
        return None

def download_all_proposals():
    """Download all final written proposals from submissions table"""
    conn = connect_to_db()
    if not conn:
        return

    cursor = conn.cursor(dictionary=True)

    try:
        # Query all submissions with final_writing
        query = """
            SELECT
                s.id,
                s.session_id,
                s.final_writing,
                s.word_count,
                s.char_count,
                s.submitted_at,
                sess.user_id,
                sess.status
            FROM submissions s
            LEFT JOIN sessions sess ON s.session_id = sess.session_id
            WHERE s.final_writing IS NOT NULL
            ORDER BY s.submitted_at DESC
        """

        cursor.execute(query)
        results = cursor.fetchall()

        print(f"\n{'='*80}")
        print(f"Found {len(results)} submissions with final writings")
        print(f"{'='*80}\n")

        if len(results) == 0:
            print("No submissions found. The database might be empty.")
            return

        # Prepare data for export
        all_proposals = []

        for i, row in enumerate(results, 1):
            submission_id = row['id']
            session_id = row['session_id']
            user_id = row['user_id'] or 'unknown_user'
            final_writing = row['final_writing']
            word_count = row['word_count']
            char_count = row['char_count']
            submitted_at = row['submitted_at']

            # Create a clean filename
            timestamp = submitted_at.strftime('%Y%m%d_%H%M%S') if submitted_at else 'no_timestamp'
            filename = f"{user_id}_{session_id[:8]}_{timestamp}.txt"

            # Save individual text file
            txt_path = os.path.join(OUTPUT_DIR, filename)
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write(final_writing)

            # Add to collection
            all_proposals.append({
                'submission_id': submission_id,
                'session_id': session_id,
                'user_id': user_id,
                'word_count': word_count,
                'char_count': char_count,
                'submitted_at': submitted_at.isoformat() if submitted_at else None,
                'filename': filename,
                'final_writing': final_writing
            })

            print(f"{i}. {filename}")
            print(f"   User ID: {user_id}")
            print(f"   Session: {session_id}")
            print(f"   Words: {word_count}, Chars: {char_count}")
            print(f"   Submitted: {submitted_at}")
            print()

        # Save all proposals to JSON
        json_path = os.path.join(OUTPUT_DIR, 'all_proposals.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(all_proposals, f, indent=2, ensure_ascii=False, default=str)

        print(f"{'='*80}")
        print(f"SUMMARY")
        print(f"{'='*80}")
        print(f"Total proposals downloaded: {len(results)}")
        print(f"Individual text files: {OUTPUT_DIR}/*.txt")
        print(f"Combined JSON file: {json_path}")
        print(f"\n✅ Download complete!")

    except mysql.connector.Error as err:
        print(f"❌ Query error: {err}")

    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    download_all_proposals()
