#!/usr/bin/env python3
"""
Strips a GenLayer contract down to what the chain actually needs to execute.

A GenLayer node refuses deploys somewhere between 48 KB and 64 KB of source, and
`contracts/proof_work.py` is 156 KB. Just under half of that is comments,
docstrings and blank lines — bytes that cost real deploy payload and buy the
chain nothing. This produces the deployable artifact while the readable source
stays in git, so nothing is lost from the repository.

Deliberately conservative. Every transformation below preserves Python
semantics exactly; none of them rename anything, reorder anything, or touch a
single expression. Identifier mangling would shrink it further and is not done
here, because a contract whose behaviour depends on an LLM reading its own
prompt strings is a bad place to be clever.

    python3 tools/minify_contract.py contracts/proof_work.py -o build/proof_work.min.py

What it removes:
  - comments (except the runner header block at the top, which the VM requires)
  - docstrings, at module, class and function level
  - blank lines
  - trailing whitespace
  - indentation beyond one space per level
  - spaces BETWEEN tokens that Python does not need (`a = b` -> `a=b`), checked
    by comparing the parse tree before and after

What it never touches:
  - the leading `#` header block, byte for byte
  - any string that is not a docstring — prompt templates included
  - the order or content of any statement
"""

from __future__ import annotations

import argparse
import ast
import io
import sys
import tokenize
from pathlib import Path


def _docstring_spans(source: str) -> set[tuple[int, int]]:
    """(start_line, end_line) of every discardable string statement, 1-based.

    Two kinds, both removable for the same reason — a bare string used as a
    statement is evaluated and thrown away, so it cannot affect behaviour:

    1. **Docstrings** — the first statement of a module, class or function.
    2. **Attribute docstrings** (PEP 258) — a string placed *after* a constant
       to document it. This contract uses that idiom heavily and it accounts
       for ~24 KB, more than the docstrings proper.

    Found via the AST, never by matching triple quotes: this contract is full of
    triple-quoted strings that are *values* (prompt templates above all), and
    deleting one of those would change what the validators are asked.

    A string that is the *only* statement in a body is kept, or the body becomes
    syntactically empty and the file stops parsing.
    """
    spans: set[tuple[int, int]] = set()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or len(body) <= 1:
            continue
        for statement in body:
            if (
                isinstance(statement, ast.Expr)
                and isinstance(statement.value, ast.Constant)
                and isinstance(statement.value.value, str)
            ):
                spans.add((statement.lineno, statement.end_lineno or statement.lineno))
    return spans


def _strip_comments(source: str) -> str:
    """Removes comment tokens, preserving everything else byte for byte.

    Uses `tokenize` rather than a regex because `#` appears inside string
    literals all over this contract — in prompts, in URL fragments, in the
    runner header — and a regex would happily corrupt them.
    """
    out: list[str] = []
    last_row, last_col = 1, 0
    lines = source.splitlines(keepends=True)

    def line(row: int) -> str:
        # ENDMARKER reports a row one past the last real line, so every lookup
        # is bounds-checked rather than assumed valid.
        return lines[row - 1] if 1 <= row <= len(lines) else ""

    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        srow, scol = tok.start
        erow, ecol = tok.end

        # Re-emit whatever sat between the previous token and this one.
        if (srow, scol) > (last_row, last_col):
            if srow == last_row:
                out.append(line(srow)[last_col:scol])
            else:
                out.append(line(last_row)[last_col:])
                for row in range(last_row + 1, srow):
                    out.append(line(row))
                out.append(line(srow)[:scol])

        if tok.type == tokenize.COMMENT:
            # Drop the comment itself; the newline after it is a separate token
            # and is preserved, so line structure survives.
            pass
        else:
            out.append(tok.string)

        last_row, last_col = erow, ecol

    return "".join(out)


def _reindent(source: str, spaces_per_level: int) -> str:
    """Rewrites leading indentation to `spaces_per_level` per level.

    Python only cares that indentation is *consistent*, not how wide it is, so
    this is semantics-preserving — but only for lines the tokenizer agrees are
    real indentation. Continuation lines inside brackets and every line of a
    multi-line string are left exactly as they are.
    """
    lines = source.split("\n")
    protected: set[int] = set()

    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.STRING and tok.end[0] > tok.start[0]:
            # Every line of a multi-line string after the first is content.
            protected.update(range(tok.start[0] + 1, tok.end[0] + 1))

    depth_of: dict[int, int] = {}
    depth = 0
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.INDENT:
            depth += 1
        elif tok.type == tokenize.DEDENT:
            depth = max(0, depth - 1)
        elif tok.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT):
            depth_of.setdefault(tok.start[0], depth)

    out: list[str] = []
    for number, line in enumerate(lines, start=1):
        if number in protected or not line.strip():
            out.append(line)
            continue
        depth = depth_of.get(number)
        if depth is None:
            out.append(line)
            continue
        out.append(" " * (spaces_per_level * depth) + line.lstrip())
    return "\n".join(out)


def minify(source: str, spaces_per_level: int = 1) -> str:
    # The GenVM header is the CONTIGUOUS leading `#` block, not line 1 alone.
    # Since the v0.3.0 runner it is two lines — a version line and the runner
    # pin — and keeping only the first would deploy a contract with no pin.
    header_lines: list[str] = []
    for line in source.split("\n"):
        if not line.startswith("#"):
            break
        header_lines.append(line)
    if not header_lines:
        raise SystemExit(
            "line 1 is not the GenVM runner header; refusing to minify blind"
        )
    header = "\n".join(header_lines)

    doc_lines: set[int] = set()
    for start, end in _docstring_spans(source):
        doc_lines.update(range(start, end + 1))

    # Docstrings go first, by line, while line numbers still match the AST.
    kept = [
        line
        for number, line in enumerate(source.split("\n"), start=1)
        if number not in doc_lines
    ]
    stage = "\n".join(kept)

    stage = _strip_comments(stage)

    # Lines lying INSIDE a multi-line string are content, not layout.
    #
    # This is not a nicety. Stripping blank lines indiscriminately collapsed the
    # paragraph breaks in the scoring prompt — six occurrences of "\n\n" became
    # "\n" — which again would have deployed cleanly and quietly changed what
    # every validator reads. `rstrip()` is just as dangerous for the same reason,
    # so both are skipped on these lines.
    # Derived from the AST, not from tokens. Python 3.12 (PEP 701) splits
    # f-strings into FSTRING_START/MIDDLE/END rather than emitting one STRING
    # token, so a token-based scan silently misses every f-string — and the
    # scoring prompt is exactly that. The AST reports one node with true start
    # and end lines regardless of quoting or Python version.
    interior: set[int] = set()
    for node in ast.walk(ast.parse(stage)):
        if isinstance(node, (ast.Constant, ast.JoinedStr)) and isinstance(
            getattr(node, "value", ""), (str, type(None))
        ):
            if isinstance(node, ast.Constant) and not isinstance(node.value, str):
                continue
            end = node.end_lineno or node.lineno
            if end > node.lineno:
                interior.update(range(node.lineno + 1, end + 1))

    # Indentation depth per line, from the tokenizer's own INDENT/DEDENT run.
    # Python only requires indentation to be *consistent*, not any particular
    # width, so narrowing it is semantics-preserving — but only for lines that
    # are layout. Anything in `interior` is string content and is emitted
    # untouched, which is what makes this safe now and unsafe before.
    depth_of: dict[int, int] = {}
    depth = 0
    for tok in tokenize.generate_tokens(io.StringIO(stage).readline):
        if tok.type == tokenize.INDENT:
            depth += 1
        elif tok.type == tokenize.DEDENT:
            depth = max(0, depth - 1)
        elif tok.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT):
            depth_of.setdefault(tok.start[0], depth)

    body: list[str] = []
    for number, line in enumerate(stage.split("\n"), start=1):
        if number in interior:
            body.append(line)
            continue
        if not line.strip():
            continue
        stripped = line.lstrip()
        level = depth_of.get(number)
        if level is None or spaces_per_level < 0:
            # A bracket continuation line, which the tokenizer reports no depth
            # for. Its leading whitespace is cosmetic, so collapse it to one
            # space rather than guessing at a nesting level.
            body.append(" " + stripped.rstrip() if line[:1].isspace() else stripped.rstrip())
        else:
            body.append(" " * (spaces_per_level * level) + stripped.rstrip())

    # Nothing may follow the header block but code — a stray comment directly
    # under it is read as part of the runner header and makes the contract
    # silently undeployable. `_strip_comments` leaves the header behind as the
    # only comment lines in `stage`, so drop exactly those from the body.
    while body and body[0].lstrip().startswith("#"):
        body = body[1:]
    text = "\n".join(body)

    # The last pass, and the one that needs proving rather than trusting: strip
    # the spaces between tokens, then refuse to hand back anything whose parse
    # tree is not identical to what went in.
    squeezed = _squeeze_spaces(text)
    if ast.dump(ast.parse(squeezed)) != ast.dump(ast.parse(text)):
        raise SystemExit(
            "REFUSING: squeezing inter-token spaces changed the parse tree"
        )
    return header + "\n" + squeezed.strip("\n") + "\n"


def _squeeze_spaces(source: str) -> str:
    """Drop the spaces BETWEEN tokens that Python does not need to read them.

    `s = str(v)` and `s=str(v)` are the same program; the three spaces are three
    bytes of deploy payload. Roughly 3.5 KB of the artifact is this, which is the
    difference between fitting under the node's pubdata ceiling and not.

    ## Why this is safe, and how that is PROVED rather than argued

    The rule is mechanical: a space between two adjacent tokens is kept only
    when removing it would let them merge into a different token — that is,
    when the left one ENDS with a word character and the right one BEGINS with
    one (`not in`, `return x`, `is None`). Everything else (`) ->`, `= (`,
    `, "`) cannot merge and the space goes.

    String tokens are emitted verbatim from `tok.string`, so nothing inside a
    quote is touched — the judgement prompt every validator reads comes through
    byte for byte. Lines that a string spans are emitted whole for the same
    reason.

    And then it is CHECKED: the caller compares the parse tree before and after
    and refuses the build if they differ. An identical AST means an identical
    program, which is a proof rather than a promise — the right standard for a
    transform that rewrites every line of a contract holding real bonds.
    """
    result: list[str] = []
    prev: tokenize.TokenInfo | None = None

    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type in (tokenize.ENDMARKER, tokenize.INDENT,
                        tokenize.DEDENT, tokenize.COMMENT):
            continue
        if tok.type in (tokenize.NEWLINE, tokenize.NL):
            result.append("\n")
            prev = None
            continue

        if prev is None:
            # First token on a physical line. Its column IS the indentation that
            # `minify` already narrowed to one space per level, so reproduce it.
            result.append(" " * tok.start[1])
        elif tok.start[0] != prev.end[0]:
            # A bracket continuation: the previous token ended on an earlier
            # line (or was a multi-line string). Keep the break and its indent.
            result.append("\n" + " " * tok.start[1])
        elif tok.start[1] > prev.end[1]:
            left, right = prev.string[-1:], tok.string[:1]
            if (left.isalnum() or left == "_") and (right.isalnum() or right == "_"):
                result.append(" ")

        result.append(tok.string)
        prev = tok

    return "".join(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--out", type=Path, required=True)
    parser.add_argument("--indent", type=int, default=1)
    args = parser.parse_args()

    source = args.source.read_text(encoding="utf8")
    result = minify(source, args.indent)

    # Non-negotiable: the output must parse, and it must expose exactly the same
    # public surface. A minifier that quietly drops a method is worse than one
    # that fails.
    before = ast.parse(source)
    after = ast.parse(result)

    def surface(tree: ast.AST) -> list[str]:
        names = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(node.name)
        return sorted(names)

    if surface(before) != surface(after):
        missing = set(surface(before)) - set(surface(after))
        extra = set(surface(after)) - set(surface(before))
        raise SystemExit(f"public surface changed! missing={missing} extra={extra}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(result, encoding="utf8")

    src_bytes = len(source.encode("utf8"))
    out_bytes = len(result.encode("utf8"))
    print(f"{args.source}  {src_bytes:,} bytes")
    print(f"{args.out}  {out_bytes:,} bytes")
    print(f"saved {src_bytes - out_bytes:,} ({100 * (1 - out_bytes / src_bytes):.1f}%)")
    print(f"definitions preserved: {len(surface(after))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
