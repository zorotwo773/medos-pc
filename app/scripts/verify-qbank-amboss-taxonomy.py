from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import qbank_reader as qbank  # noqa: E402


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_equal(actual, expected, message: str) -> None:
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def count_questions_for_subject(db: str, subject_id: int) -> int:
    conn = qbank._conn(db)
    try:
        where, params = qbank._question_where(
            db,
            subject_id,
            None,
            "",
            "",
            "",
            False,
        )
        return conn.execute(
            "SELECT COUNT(*) FROM Questions q "
            "LEFT JOIN Subjects subj ON subj.id=q.subId "
            "LEFT JOIN Systems sys ON sys.id=q.sysId "
            f"{where}",
            params,
        ).fetchone()[0]
    finally:
        conn.close()


def count_questions_for_system_token(db: str, system_token: int) -> int:
    conn = qbank._conn(db)
    try:
        where, params = qbank._question_where(
            db,
            None,
            None,
            "",
            "",
            "",
            False,
            system_ids=[system_token],
        )
        return conn.execute(
            "SELECT COUNT(*) FROM Questions q "
            "LEFT JOIN Subjects subj ON subj.id=q.subId "
            "LEFT JOIN Systems sys ON sys.id=q.sysId "
            f"{where}",
            params,
        ).fetchone()[0]
    finally:
        conn.close()


def main() -> None:
    question = qbank.question(1, db="amboss1")

    assert_true("Allergy and immunology" in question["subject"], "AMBOSS CSV subject IDs should resolve to source subject names")
    assert_true("Dermatology" in question["subject"], "AMBOSS multi-subject questions should include every mapped subject")
    assert_true("Pathology" in question["subject"], "AMBOSS multi-subject questions should not drop later subject IDs")
    assert_true("Question - 1" not in question["tags"], "AMBOSS numeric question titles should not become topic tags")
    assert_true("Allergy and immunology" in question["tags"], "AMBOSS subject tags should be generated from resolved subject names")

    assert_equal(count_questions_for_subject("amboss1", 31), 33, "Legal medicine and ethics should match AMBOSS source count")
    assert_equal(count_questions_for_subject("amboss1", 2), 272, "Allergy and immunology should match AMBOSS source count")

    system_rows = qbank.systems(db="amboss1", subject_id=None, group="")
    assert_true(len(system_rows) > 100, "AMBOSS systems picker should expose source subject-system subsystems, not only 18 broad systems")
    immune_allergy = next((row for row in system_rows if row["name"] == "Immune System (Allergy and immunology)"), None)
    assert_true(immune_allergy is not None, "AMBOSS systems should include source subsystem rows from SubjectsSystems")
    assert_equal(immune_allergy["count"], 115, "Immune System / Allergy and immunology should match source bridge count")
    assert_equal(immune_allergy.get("group_count"), 156, "AMBOSS subsystem rows should carry the broad organ-system count for parent display")
    assert_equal(
        count_questions_for_system_token("amboss1", immune_allergy["id"]),
        115,
        "Selecting an AMBOSS subsystem row should filter by both system and source subject",
    )

    print("QBank AMBOSS taxonomy checks passed")


if __name__ == "__main__":
    main()
