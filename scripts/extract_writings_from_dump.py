#!/usr/bin/env python3
"""Extract final writings from a MySQL dump without losing embedded newlines."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def decode_escape(char: str) -> str:
    return {
        "0": "\0",
        "'": "'",
        '"': '"',
        "b": "\b",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "Z": "\x1a",
        "\\": "\\",
        "%": "%",
        "_": "_",
    }.get(char, char)


def parse_values(values_sql: str) -> list[list[object | None]]:
    rows: list[list[object | None]] = []
    current_row: list[object | None] | None = None
    token: list[str] = []
    in_string = False
    was_string = False
    i = 0

    def finish_token() -> None:
        nonlocal token, was_string
        if current_row is None:
            return
        raw = "".join(token)
        if was_string:
            value: object | None = raw
        else:
            stripped = raw.strip()
            if stripped.upper() == "NULL":
                value = None
            elif re.fullmatch(r"-?\d+", stripped or ""):
                value = int(stripped)
            else:
                value = stripped
        current_row.append(value)
        token = []
        was_string = False

    while i < len(values_sql):
        ch = values_sql[i]

        if in_string:
            if ch == "\\" and i + 1 < len(values_sql):
                token.append(decode_escape(values_sql[i + 1]))
                i += 2
                continue
            if ch == "'":
                in_string = False
                was_string = True
                i += 1
                continue
            token.append(ch)
            i += 1
            continue

        if ch == "'":
            in_string = True
            i += 1
        elif ch == "(":
            current_row = []
            token = []
            was_string = False
            i += 1
        elif ch == ",":
            if current_row is not None:
                finish_token()
            i += 1
        elif ch == ")":
            if current_row is not None:
                finish_token()
                rows.append(current_row)
                current_row = None
            i += 1
        elif ch == ";":
            break
        else:
            token.append(ch)
            i += 1

    return rows


def safe_part(value: object | None, fallback: str) -> str:
    text = str(value or fallback)
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_") or fallback


def main() -> int:
    dump_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/Users/yanliu/backup.sql")
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("extracted_writings_fixed")
    output_dir.mkdir(parents=True, exist_ok=True)

    session_to_user: dict[str, str] = {}
    submissions: list[dict[str, object | None]] = []

    with dump_path.open("r", encoding="utf-8", errors="replace") as dump:
        for line in dump:
            if line.startswith("INSERT INTO `sessions` VALUES "):
                values_sql = line.split(" VALUES ", 1)[1]
                for row in parse_values(values_sql):
                    if len(row) >= 2 and row[0]:
                        session_to_user[str(row[0])] = str(row[1] or "unknown_user")

            if line.startswith("INSERT INTO `submissions` VALUES "):
                values_sql = line.split(" VALUES ", 1)[1]
                for row in parse_values(values_sql):
                    if len(row) < 12 or row[2] is None:
                        continue
                    session_id = str(row[1] or "unknown_session")
                    submissions.append(
                        {
                            "submission_id": row[0],
                            "session_id": session_id,
                            "user_id": session_to_user.get(session_id, "unknown_user"),
                            "final_writing": row[2],
                            "transcript_file_url": row[3],
                            "chat_history_file_url": row[4],
                            "interaction_logs_file_url": row[5],
                            "audio_file_url": row[6],
                            "word_count": row[7],
                            "char_count": row[8],
                            "session_start_timestamp": row[9],
                            "recording_start_timestamp": row[10],
                            "submitted_at": row[11],
                        }
                    )

    submissions.sort(key=lambda item: str(item.get("submitted_at") or ""), reverse=True)

    summary = []
    for index, row in enumerate(submissions, 1):
        user_id = safe_part(row["user_id"], "unknown_user")
        session_id = safe_part(row["session_id"], "unknown_session")[:18]
        submitted_at = safe_part(row["submitted_at"], "no_time")
        filename = f"{index:03d}_{user_id}_{session_id}_{submitted_at}.txt"
        output_path = output_dir / filename
        final_writing = str(row["final_writing"] or "")
        output_path.write_text(final_writing, encoding="utf-8")
        summary.append({**row, "filename": filename})

    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Extracted {len(submissions)} writings to {output_dir.resolve()}")
    print(f"Summary: {(output_dir / 'summary.json').resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
