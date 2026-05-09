from __future__ import annotations

from search_sidecar.index.chunking import MAX_CHUNK_CHARS, chunk_text


def _assert_bounded(chunks: list[str]) -> None:
    assert chunks
    assert all(0 < len(chunk) <= MAX_CHUNK_CHARS for chunk in chunks)


def test_keeps_short_markdown_blocks_separate():
    text = "# Heading\n\nThis is the first paragraph.\n\nAnd the second."

    assert chunk_text(text) == [
        "# Heading",
        "This is the first paragraph.",
        "And the second.",
    ]


def test_keeps_setext_heading_source_block_together():
    text = "Heading\n=======\n\nBody"

    assert chunk_text(text) == ["Heading\n=======", "Body"]


def test_keeps_short_fenced_code_block_together():
    text = "Intro\n\n```python\nprint('hello')\n```\n\nTail"

    assert chunk_text(text) == [
        "Intro",
        "```python\nprint('hello')\n```",
        "Tail",
    ]


def test_splits_markdown_table_by_rows():
    rows = ["| Name | Value |", "| --- | --- |"]
    rows.extend(f"| row {idx} | {'value ' * 10} |" for idx in range(30))

    chunks = chunk_text("\n".join(rows))

    _assert_bounded(chunks)
    assert len(chunks) > 1
    for chunk in chunks:
        assert all(
            line.startswith("|") and line.endswith("|")
            for line in chunk.splitlines()
        )


def test_keeps_html_table_block_together_when_short():
    text = "\n".join(
        [
            "Before",
            "",
            "<table>",
            "<tr><td>A</td><td>B</td></tr>",
            "</table>",
            "",
            "After",
        ]
    )

    assert chunk_text(text) == [
        "Before",
        "<table>\n<tr><td>A</td><td>B</td></tr>\n</table>",
        "After",
    ]


def test_splits_long_markdown_lists_by_source_lines():
    text = "\n".join(f"- item {idx} {'value ' * 12}" for idx in range(30))

    chunks = chunk_text(text)

    _assert_bounded(chunks)
    assert len(chunks) > 1
    assert all(
        line.startswith("- item ")
        for chunk in chunks
        for line in chunk.splitlines()
    )


def test_splits_english_sentences_without_space_after_period():
    text = ("Alpha sentence.Beta sentence!Gamma question? " * 35).strip()

    chunks = chunk_text(text)

    _assert_bounded(chunks)
    assert len(chunks) > 1
    assert all("sentence.Beta" not in chunk for chunk in chunks)


def test_hard_wrap_prefers_word_boundaries():
    tokens = [f"token{idx:03d}" for idx in range(200)]

    chunks = chunk_text(" ".join(tokens))

    _assert_bounded(chunks)
    assert len(chunks) > 1
    assert " ".join(chunks).split() == tokens
