from pathlib import Path

from agent import deny_reason, make_permission_handler

SCRATCH = Path("/tmp/local-link-scratch").resolve()
DATA = "/Users/someone/books/book.gnucash"
OPTIONS = [{"value": "proceed_once"}, {"value": "proceed_always"}, {"value": "cancel"}]


def execute(command: str, impact: str = "medium") -> dict:
    return {"type": "exec", "fullCommand": command, "impactLevel": impact}


def patch(path: str) -> dict:
    return {
        "type": "apply_patch",
        "filePath": path,
        "patchContent": f"*** Begin Patch\n*** Add File: {path}\n+hi\n*** End Patch",
    }


def test_allows_writes_in_scratch():
    assert deny_reason(patch(str(SCRATCH / "extract.py")), SCRATCH) is None
    assert deny_reason({"type": "create", "filePath": "check.py"}, SCRATCH) is None


def test_blocks_writes_to_data_path():
    assert "only allowed inside" in deny_reason(patch(DATA), SCRATCH)
    assert deny_reason({"type": "edit", "filePath": DATA}, SCRATCH) is not None


def test_blocks_patch_that_sneaks_a_second_file_out():
    action = patch(str(SCRATCH / "extract.py"))
    action["patchContent"] += f"\n*** Update File: {DATA}\n"
    assert deny_reason(action, SCRATCH) is not None


def test_blocks_path_escape_from_scratch():
    assert deny_reason(patch(str(SCRATCH / ".." / "x.py")), SCRATCH) is not None


def test_allows_read_only_commands():
    assert deny_reason(execute(f"sqlite3 {DATA} .tables", impact="low"), SCRATCH) is None


def test_allows_running_scratch_scripts():
    assert deny_reason(execute(f"python3 extract.py {DATA}"), SCRATCH) is None
    assert deny_reason(execute(f"uv run python {SCRATCH}/check.py {DATA}"), SCRATCH) is None


def test_blocks_other_commands():
    assert deny_reason(execute(f"rm {DATA}"), SCRATCH) is not None
    assert deny_reason(execute("python3 /etc/evil.py"), SCRATCH) is not None
    assert deny_reason(execute("python3 -c 'print(1)'"), SCRATCH) is not None


def test_blocks_unknown_actions():
    assert deny_reason({"type": "mcp_tool"}, SCRATCH) is not None


def script_request(*confirmations: dict) -> dict:
    calls = [{"toolName": "X", "confirmation": c} for c in confirmations]
    calls.append({"toolName": "TodoWrite"})  # no confirmation needed
    return {
        "toolUses": [{"confirmationType": "script", "details": {"type": "script", "calls": calls}}],
        "options": OPTIONS,
    }


def test_script_request_approved_when_every_call_is_allowed():
    events = []
    policy = make_permission_handler(SCRATCH, lambda *e: events.append(e)).raw_policy
    raw = script_request(patch(str(SCRATCH / "extract.py")), execute("python3 extract.py /d"))
    assert policy(raw) == {"selectedOption": "proceed_once"}
    assert events == []


def test_script_request_cancelled_when_any_call_is_blocked():
    events = []
    policy = make_permission_handler(SCRATCH, lambda *e: events.append(e)).raw_policy
    raw = script_request(patch(str(SCRATCH / "extract.py")), patch(DATA))
    response = policy(raw)
    assert response["selectedOption"] == "cancel"
    assert DATA in response["comment"]
    assert events[0][0] == "denied"


def test_plain_request_uses_same_policy():
    policy = make_permission_handler(SCRATCH, lambda *e: None).raw_policy
    raw = {"toolUses": [{"confirmationType": "exec", "details": execute(f"rm {DATA}")}], "options": OPTIONS}
    assert policy(raw)["selectedOption"] == "cancel"


def test_allows_cd_into_scratch_then_running_script():
    # Droid reports extractedCommands as just ["python"]; the full command is what counts.
    action = execute(f"cd {SCRATCH} && python probe.py")
    action["extractedCommands"] = ["python"]
    assert deny_reason(action, SCRATCH) is None


def test_relative_script_resolves_against_cd_target():
    assert deny_reason(execute("cd /Users/someone/books && python evil.py"), SCRATCH) is not None


def test_blocks_pipes_redirects_and_subshells():
    assert deny_reason(execute(f"python extract.py {DATA} > {DATA}.json"), SCRATCH) is not None
    assert deny_reason(execute(f"python extract.py {DATA} | tee /tmp/x"), SCRATCH) is not None
    assert deny_reason(execute("python extract.py $(rm -rf /)"), SCRATCH) is not None
    assert deny_reason(execute("python extract.py; rm -rf /"), SCRATCH) is not None
