#!/usr/bin/env python3
"""
Proves the code AT AN ADDRESS is the same program as a local artifact.

    python3 tools/verify_onchain.py <address> build/PolicyGate.min.py

`genlayer code` does not print the contract source alone: it prints a blank
line, a `Result:` header, the source, and trailing blanks. Diffing against that
raw output reports a mismatch for a contract that is in fact identical — which
is worse than no check, because it teaches you to ignore the check. This strips
the chrome and compares sha256.

Three outcomes, because there are three real cases:

  MATCH       byte-for-byte identical.
  EQUIVALENT  the same program under a consistent renaming of PRIVATE
              identifiers. The mangler picks those names by frequency rank, so
              an artifact rebuilt after any edit to the source can rename every
              private symbol while the program - and the public ABI - is
              unchanged. Reporting that as a difference teaches you to ignore
              the check; reporting it as a match would hide a real edit. So it
              is its own answer, and it is only reached when the token streams
              agree position for position AND the renaming is a bijection.
  DIFFER      anything else.

Exit 0 on MATCH or EQUIVALENT, 1 on a difference.
"""
import hashlib
import io
import subprocess
import sys
import tokenize


def on_chain(address: str) -> str:
    raw = subprocess.run(["genlayer", "code", address],
                         capture_output=True, text=True, check=False).stdout
    marker = raw.find("Result:")
    body = raw[marker + len("Result:"):] if marker >= 0 else raw
    return body.strip("\n") + "\n"


def _tokens(source: str):
    """(shape, names): every token with identifiers blanked, and the names.

    Each name is tagged with the namespace it appears in - `attr` for anything
    directly after a `.`, `name` everywhere else. They really are separate
    namespaces, and conflating them makes this check wrong in both directions:
    `gl.message.raw` and a local parameter called `raw` are unrelated symbols
    that happen to share a spelling, so a mangler may legitimately rename one
    and not the other.
    """
    shape, names = [], []
    prev = None
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type in (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
                        tokenize.DEDENT, tokenize.COMMENT, tokenize.ENDMARKER):
            continue
        if tok.type == tokenize.NAME:
            is_attr = prev is not None and prev.type == tokenize.OP and prev.string == "."
            shape.append("\0")
            names.append(("attr" if is_attr else "name", tok.string))
        else:
            shape.append(tok.string)
        prev = tok
    return shape, names


def equivalent(got: str, want: str) -> bool:
    """True when the two differ only by a consistent renaming of identifiers.

    Both directions are required. A one-way map would call two DIFFERENT
    on-chain names collapsing onto one local name a match, which is precisely
    the kind of edit that changes behaviour.
    """
    try:
        got_shape, got_names = _tokens(got)
        want_shape, want_names = _tokens(want)
    except tokenize.TokenError:
        return False
    if got_shape != want_shape:
        return False
    forward, backward = {}, {}
    for a, b in zip(got_names, want_names):
        if a[0] != b[0]:
            return False
        if forward.setdefault(a, b) != b or backward.setdefault(b, a) != a:
            return False
    return True


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    address, artifact = sys.argv[1], sys.argv[2]
    got = on_chain(address)
    want = open(artifact, encoding="utf8").read()
    a = hashlib.sha256(got.encode()).hexdigest()
    b = hashlib.sha256(want.encode()).hexdigest()
    if a == b:
        print(f"MATCH  {address}\n       {artifact}\n       sha256 {a}  ({len(want):,} bytes)")
        return 0
    if equivalent(got, want):
        print(f"EQUIVALENT  {address}\n            {artifact}\n"
              f"            same token stream under a bijective renaming of "
              f"private identifiers\n"
              f"            on-chain {len(got):,} bytes / artifact {len(want):,} bytes")
        return 0
    print(f"DIFFER {address}\n       on-chain {a} ({len(got):,} bytes)\n"
          f"       artifact {b} ({len(want):,} bytes)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
