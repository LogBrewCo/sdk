from __future__ import annotations

from pathlib import Path


DEFAULT_BREAKPAD_MODULE_ID = "00112233445566778899AABBCCDDEEFF2A"
DEFAULT_BREAKPAD_SOURCE_PATH = "src/app/checkout.cpp"
DEFAULT_BREAKPAD_SYMBOL_NAME = "checkout_handler"


def breakpad_symbol_text(
    *,
    module_id: str = DEFAULT_BREAKPAD_MODULE_ID,
    module_os: str = "windows",
    cpu: str = "x86",
    module_name: str = "checkout.pdb",
    include_file_records: bool = True,
) -> str:
    lines = [f"MODULE {module_os} {cpu} {module_id} {module_name}"]
    if include_file_records:
        lines.append(f"FILE 0 {DEFAULT_BREAKPAD_SOURCE_PATH}")
        lines.append(f"FUNC 1000 20 0 {DEFAULT_BREAKPAD_SYMBOL_NAME}")
    else:
        lines.append("PUBLIC 1010 0 checkout_public")
    return "\n".join(lines) + "\n"


def write_breakpad_symbol(output_path: Path, **kwargs: object) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(breakpad_symbol_text(**kwargs), encoding="ascii")
