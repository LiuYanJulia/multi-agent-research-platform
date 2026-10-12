#!/bin/bash
#
# Download all final written proposals from remote Docker MySQL database
# This script connects to the remote server running Docker and exports the data
#

# Configuration
REMOTE_HOST="your-server-hostname-or-ip"  # UPDATE THIS
REMOTE_USER="your-username"                # UPDATE THIS
OUTPUT_DIR="downloaded_proposals"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=================================="
echo "Research Platform Proposal Downloader"
echo "=================================="
echo

# Create output directory
mkdir -p "$OUTPUT_DIR"

# SQL query to export proposals
SQL_QUERY="SELECT
    s.id as submission_id,
    s.session_id,
    sess.user_id,
    s.word_count,
    s.char_count,
    s.submitted_at,
    s.final_writing
FROM submissions s
LEFT JOIN sessions sess ON s.session_id = sess.session_id
WHERE s.final_writing IS NOT NULL
ORDER BY s.submitted_at DESC;"

echo -e "${YELLOW}Connecting to remote Docker MySQL...${NC}"

# Execute the query via docker exec on remote host
# The docker exec command runs inside the research-db container
REMOTE_COMMAND="docker exec -i research-db mysql -uresearch_user -psecurePassword2025 research_platform -e \"$SQL_QUERY\" --batch --raw"

# Note: You may need to set up SSH keys for passwordless login
# Or you'll be prompted for password
echo -e "${YELLOW}Executing query...${NC}"

# Export to TSV format
ssh "$REMOTE_USER@$REMOTE_HOST" "$REMOTE_COMMAND" > "$OUTPUT_DIR/proposals_raw.tsv"

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to connect to remote database${NC}"
    echo "Please check:"
    echo "  1. SSH connection to $REMOTE_HOST"
    echo "  2. Docker container 'research-db' is running"
    echo "  3. Database credentials are correct"
    exit 1
fi

echo -e "${GREEN}✅ Data exported to $OUTPUT_DIR/proposals_raw.tsv${NC}"
echo

# Count submissions
NUM_SUBMISSIONS=$(tail -n +2 "$OUTPUT_DIR/proposals_raw.tsv" | wc -l | tr -d ' ')
echo -e "${GREEN}Found $NUM_SUBMISSIONS submissions${NC}"
echo

echo -e "${YELLOW}Processing individual proposal files...${NC}"

# Process the TSV to create individual text files
python3 << 'PYTHON_SCRIPT'
import csv
import os
from datetime import datetime

OUTPUT_DIR = 'downloaded_proposals'

# Read the TSV file
with open(f'{OUTPUT_DIR}/proposals_raw.tsv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter='\t')

    proposals = []
    for i, row in enumerate(reader, 1):
        submission_id = row['submission_id']
        session_id = row['session_id']
        user_id = row.get('user_id') or 'unknown_user'
        final_writing = row['final_writing']
        word_count = row.get('word_count', 0)
        char_count = row.get('char_count', 0)
        submitted_at = row.get('submitted_at', 'no_timestamp')

        # Create filename
        if submitted_at != 'no_timestamp':
            try:
                dt = datetime.fromisoformat(submitted_at.replace('Z', '+00:00'))
                timestamp = dt.strftime('%Y%m%d_%H%M%S')
            except:
                timestamp = 'no_timestamp'
        else:
            timestamp = 'no_timestamp'

        filename = f"{user_id}_{session_id[:8]}_{timestamp}.txt"

        # Save individual file
        with open(f'{OUTPUT_DIR}/{filename}', 'w', encoding='utf-8') as outfile:
            outfile.write(final_writing)

        print(f"{i}. {filename} (words: {word_count})")

        proposals.append({
            'submission_id': submission_id,
            'session_id': session_id,
            'user_id': user_id,
            'filename': filename,
            'word_count': word_count,
            'char_count': char_count,
            'submitted_at': submitted_at
        })

    # Save summary JSON
    import json
    with open(f'{OUTPUT_DIR}/proposals_summary.json', 'w', encoding='utf-8') as f:
        json.dump(proposals, f, indent=2, ensure_ascii=False)

print(f"\n✅ Created {len(proposals)} individual proposal files")
print(f"📁 Files saved in: {OUTPUT_DIR}/")
PYTHON_SCRIPT

echo
echo -e "${GREEN}=================================="
echo "Download complete!"
echo "==================================${NC}"
echo "Output directory: $OUTPUT_DIR/"
echo "  - Individual .txt files (one per user)"
echo "  - proposals_summary.json (metadata)"
echo "  - proposals_raw.tsv (raw export)"
