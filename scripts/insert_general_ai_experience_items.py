"""Insert participant-perception items into the current pilot questionnaire.

This script deliberately uses the live DOCX as its source and only inserts new
content immediately before the existing Part 4 heading, preserving all manual
edits elsewhere in the document.
"""

from copy import deepcopy
import importlib.util
from pathlib import Path

from docx import Document


QUESTIONNAIRE = Path("pilot_participant_introductions/Pilot_Study_Post_Task_Questionnaire.docx")
BUILDER = Path("scripts/create_pilot_post_task_questionnaire.py")


def load_builder():
    spec = importlib.util.spec_from_file_location("questionnaire_builder", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not QUESTIONNAIRE.exists():
        raise FileNotFoundError(QUESTIONNAIRE)

    builder = load_builder()
    document = Document(QUESTIONNAIRE)

    part4 = next(
        (paragraph for paragraph in document.paragraphs
         if paragraph.text.strip() == "Part 4 Platform and study procedure"),
        None,
    )
    if part4 is None:
        raise ValueError("Could not find the Part 4 insertion point.")

    anchor = part4._p.getprevious()
    # The source form places a spacer paragraph between each Likert table and
    # the next heading. Keep that spacer with the preceding Part 3 content.
    while anchor is not None and anchor.tag.endswith("}p") and not "".join(anchor.itertext()).strip():
        anchor = anchor.getprevious()
    if anchor is None or not anchor.tag.endswith("}tbl"):
        raise ValueError("Expected the Part 3 table directly before Part 4.")

    fragment = Document()
    builder.add_heading(fragment, "Part 3A Your role and creative contribution")
    builder.add_body(
        fragment,
        "In this section, “AI support” includes both ordinary AI chat responses and, if shown, additional AI guidance. Please rate each statement.",
        after=4,
    )

    builder.add_heading(fragment, "Responsibility", level=2)
    builder.add_likert_table(fragment, [
        "I felt responsible for the final response I submitted.",
        "Even when I used AI support, I felt responsible for deciding what to include in my final response.",
        "I would be comfortable being held accountable for the decisions reflected in my final response.",
    ])

    builder.add_heading(fragment, "Ownership", level=2)
    builder.add_likert_table(fragment, [
        "The final response felt like my own work.",
        "I felt personally connected to the final response.",
        "The ideas represented in the final response reflected my own contribution.",
    ])

    builder.add_heading(fragment, "Perceived creativity", level=2)
    builder.add_likert_table(fragment, [
        "I consider my final response to be creative.",
        "My final response included ideas that were original.",
        "My final response combined ideas in a novel way.",
    ])

    # The last child is the fragment document's section properties, which must
    # not be inserted into the middle of the questionnaire.
    insert_after = anchor
    for element in list(fragment.element.body):
        if element.tag.endswith("}sectPr"):
            continue
        copied = deepcopy(element)
        insert_after.addnext(copied)
        insert_after = copied

    document.save(QUESTIONNAIRE)
    print(QUESTIONNAIRE)


if __name__ == "__main__":
    main()
