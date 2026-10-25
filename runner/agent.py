"""Droid agent sessions in their own temp folder: one writes extract.py (reading an
app's data), the other writes write.py (adding transactions to it)."""

import re
import shlex
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

from droid_sdk import (
    AssistantMessage,
    Autonomy,
    ErrorEvent,
    InteractionHandlers,
    PermissionRequest,
    PermissionResponse,
    QuestionRequest,
    QuestionResponse,
    Session,
    SessionConfig,
    ToolCall,
    ToolConfirmationOutcome,
    ToolResult,
)
from droid_sdk._high_level.interaction_adapter import InteractionDispatcher

Emit = Callable[[str, str, str], None]  # (kind, label, detail)

AGENT_TIMEOUT_SECONDS = 15 * 60

PROMPT = """\
Connect to the local accounting app "{app}". Its data is at:

    {data_path}

Write an extractor that outputs normalized rows. A checker verifies your output, and
later runs compare it with earlier loads row by row (added, changed, deleted), so every
row needs a stable ID.

## Deliverable: extract.py in the working folder
Run as: python extract.py <data_path>
Prints to stdout a JSON array with one object per posting line (split), every
transaction included. Each object has exactly these keys:
- date: "YYYY-MM-DD"
- account: the account's full path from its top-level account, levels joined by ":"
  (e.g. "Expenses:Office:Rent"), with names exactly as the app shows them
- amount: positive decimal string with 2 places, e.g. "50.00"
- side: "debit" or "credit"
- memo: string, may be empty
- source: a unique, stable ID for this posting line built from the app's own IDs
  (e.g. "transactions/<transaction id>/splits/<split id>"). Never a row number or
  position: the same entry must get the same source on every run.
Do not drop, net, merge or adjust entries.

## What the rows must represent
Together the rows are a double-entry ledger of the app's books: each transaction's
debits equal its credits. Apps don't all store data that way, so before writing code,
work out from the data how this app models money. Where it already keeps balanced
postings, emit them as they are. Where it doesn't, derive the postings its records
imply, using only what the data says. Never invent amounts, accounts or categories;
leave anything the app hasn't assigned visibly unassigned instead of guessing. Make sure
nothing is counted twice, and that nothing the app treats as deleted or superseded is
included.

## Access
- The data path is READ-ONLY. Never create, modify, move or delete anything there.
  Open databases read-only (SQLite: sqlite3.connect("file:<path>?mode=ro", uri=True)).
- Your working folder is {workspace}. Write files only there.
- Commands are limited to read-only ones, or `python <script>.py` for a script in the
  working folder. Anything else is refused. To run other programs, call them from a
  .py script in the working folder with subprocess, and run that script.
- If an action is refused, don't stop: take an allowed route and keep going.

## Rules
- Python 3 standard library only. No network.
- Your script prints only JSON to stdout.
- Run it against the data path to confirm it works before you finish.
- Finish with a short summary of the data format and how your script works.

## Work fast
- Inspect the data with a few quick commands, write the script, run it, and stop.
- Don't build validation harnesses, probe suites or READMEs; the pipeline checks
  your output.
"""

REPAIR = """
## Previous attempt failed the checker
Your extract.py is already in the working folder. The checker rejected its output:
{differences}

Work out whether your script misreads the app's data, or whether the books themselves
have a real problem. Reason it out from the data: is part of how the app models money
missing from your script, or does the app itself hold the entries that way? Fix your
script only if it is wrong. Never hide, drop or alter
entries to make the checks pass. If your script is right, leave it and explain why in
your summary.
"""

UI = """
## UI automation is enabled for this run
{why} You may also drive the app's own interface, but only "{app}":
- `osascript -e '<AppleScript>'` that tells application "{app}", or System Events'
  `process "{app}"`. No `do shell script`, no other apps, no file or folder commands.
- `screencapture -x {workspace}/<name>.png` to see the screen. Screenshots are lower
  confidence than data, so use them to navigate, not as the source of numbers.
- `cliclick` for clicks and keys when menus can't be scripted.
Every UI action is logged and shown to the user.

Prefer the app's own export: open its File/Export (or Reports) menu, export to CSV, QIF or
similar, saving into {workspace}. GTK apps such as GnuCash expose only their menu bar to
accessibility, not their dialogs; inside a dialog use keystrokes (Tab, Return, typing a
path, Cmd+Shift+G in file pickers) or cliclick, and take a screenshot to check where you
are. Then write extract.py so it can redo the whole thing on its own: drive the same
export via subprocess, wait for the file, and parse it. It must still output every
posting line with stable source IDs from the app's data.
"""

WRITE = """\
Add transactions to the local accounting app "{app}". A copy of its data is at:

    {data_copy}

That copy is inside your working folder and is yours to change; the user's real file is
never given to you. The transactions to add are in {workspace}/{transactions}: a JSON
array of {{"date": "YYYY-MM-DD", "description", "num", "splits": [{{"account": full path
joined by ":", "amount": positive decimal string, "side": "debit" or "credit", "memo"}}]}}.
Each transaction's debits equal its credits.

## Deliverables in the working folder
1. method.json, always:
   {{"method": "api" | "importer" | "file" | "ui" | "none",
     "summary": "how the write works, in two sentences",
     "skipped": {{"<each method above the chosen one>": "why it isn't usable here"}},
     "app_must_be_closed": true or false,
     "process_names": ["names of the app's processes, as ps shows them"],
     "lock_files": ["lock files the app keeps, with {{data_path}} for the data path"]}}
2. write.py, unless the method is "none". Run as:
       python write.py <data_path> <transactions.json>
   It adds every transaction and nothing else, then exits 0. If anything is wrong (an
   account doesn't exist, the data is locked, the app is running, the format isn't what
   you expect) it changes nothing and exits non-zero with the reason on stderr. Exit 3
   when the data is locked or the app is running. It must work on any copy of this data,
   not just the one here.

## Pick the method: go down this list and take the first one that works
1. api: the app's own scripting interface, command line tool or official library that is
   installed on this machine and writes through the app's own code.
2. importer: an import the app can run without its UI, fed a file you generate (CSV,
   QIF, OFX). It must add to the books, never replace them.
3. file: writing the data file yourself, only when the format is open and you have
   confirmed from the data exactly how the app stores a transaction. Mirror an existing
   transaction field by field: ID format, date formats, time of day, counters, and any
   metadata the app keeps beside each transaction. Write atomically (one database
   transaction, or a temp file then rename) and leave everything else as it was, byte
   for byte where you can. Respect the app's lock (lock table or lock file).
4. ui: only if UI automation is enabled for this run (see below).
5. none: if nothing above is safe, write method.json with "none" and the reason. That is
   an acceptable answer. A guess is not.
Record in "skipped" why each method above the one you chose doesn't work here.

## Rules for any method
- Only add. Never change, delete or reorder anything already in the data.
- Never create accounts. If one is missing, fail.
- Never write an encrypted, proprietary or undocumented binary format directly.
- Amounts and dates exactly as given. Python 3 standard library only. No network.

## Prove it before you finish
extract.py (the app's saved extractor) is in the working folder. Run
`python extract.py {data_copy}`, then `python write.py {data_copy} {transactions}`, then
extract again: the new rows must be exactly one per split you were given, and nothing
else may change. The pipeline repeats this on a fresh copy before the user's file is
touched. Finish with a short summary of the method and why you chose it.

## The app may be open
The copy is yours alone, so the app being open doesn't stop you working on it. Don't
wait for the app to close and don't ask anyone to close it: record its process names and
lock files in method.json, and the pipeline makes sure it's closed before the user's real
file is written.

## Access
- No one can answer questions during this session. Decide from these rules; if you can't
  go on safely, say why in method.json ("none") and finish.
- Write files only in {workspace}. Commands are limited to read-only ones, or
  `python <script>.py` for a script in the working folder. To run other programs, call
  them from a .py script in the working folder with subprocess.
- If an action is refused, take an allowed route and keep going.
"""

WRITE_REPAIR = """
## Previous attempt failed verification
Your files are in the working folder. Running write.py on a fresh copy failed:
{differences}

Fix write.py (or switch method, following the order above). If no method is safe,
write method.json with "none" and the reason.
"""

NUDGE = """\
Your last action was refused by the session policy: {reason}

That doesn't end the task. Take an allowed route (read-only commands, or write a .py
script in the working folder and run it with python) and finish {script}.
"""

MAX_NUDGES = 2
AGENT_NAME = "Extractor agent"
SCRIPT = "extract.py"

PYTHON = re.compile(r"^python3?(?:\.\d+)?$")


@dataclass(frozen=True)
class UiScope:
    """UI automation allowed for one run: only on this app, screenshots only into scratch."""

    app: str
    why: str = "Reading the data directly didn't produce rows the checker accepts."


def build_write_prompt(
    app: str, data_copy: Path, workspace: Path, transactions: str, error: list[str] | None,
    ui: UiScope | None = None,
) -> str:
    prompt = WRITE.format(app=app, data_copy=data_copy, workspace=workspace, transactions=transactions)
    if error:
        prompt += WRITE_REPAIR.format(differences="\n".join(f"- {d}" for d in error))
    if ui:
        prompt += UI.format(app=ui.app, why=ui.why, workspace=workspace)
    return prompt


def build_prompt(
    app: str, data_path: Path, workspace: Path, error: list[str] | None, ui: UiScope | None = None
) -> str:
    prompt = PROMPT.format(app=app, data_path=data_path, workspace=workspace)
    if error:
        prompt += REPAIR.format(differences="\n".join(f"- {d}" for d in error))
    if ui:
        prompt += UI.format(app=ui.app, why=ui.why, workspace=workspace)
    return prompt


def _inside(path: str | None, root: Path) -> bool:
    if not path:
        return False
    p = Path(path).expanduser()
    return (p if p.is_absolute() else root / p).resolve().is_relative_to(root)


def _runs_scratch_scripts(command: str, scratch: Path) -> bool:
    """True if the command only cds around and runs .py scripts that live in scratch.

    Droid's extractedCommands drops arguments (just ["python"]), so parse the full
    command: segments joined by && or ;, no pipes, redirects or subshells.
    """
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return False
    if any(t in ("`",) or "$(" in t for t in tokens):
        return False
    segments: list[list[str]] = [[]]
    for token in tokens:
        if token in ("&&", ";"):
            segments.append([])
        elif token and set(token) <= set("|&<>();"):
            return False
        else:
            segments[-1].append(token)

    cwd = scratch
    ran_script = False
    for parts in segments:
        if not parts:
            continue
        if parts[0] == "cd" and len(parts) == 2:
            target = Path(parts[1]).expanduser()
            cwd = (target if target.is_absolute() else cwd / target).resolve()
            continue
        if parts[:2] == ["uv", "run"]:
            parts = parts[2:]
        if len(parts) < 2 or not PYTHON.match(Path(parts[0]).name):
            return False
        script = Path(parts[1]).expanduser()
        if script.suffix != ".py":
            return False
        if not (script if script.is_absolute() else cwd / script).resolve().is_relative_to(scratch):
            return False
        ran_script = True
    return ran_script


UI_TOOLS = ("osascript", "screencapture", "cliclick")
# AppleScript that reaches outside the app's UI: shell, other scripts, files, URLs.
APPLESCRIPT_FORBIDDEN = re.compile(
    r"\b(do\s+shell\s+script|do\s+javascript|run\s+script|load\s+script|store\s+script|"
    r"open\s+location|delete|duplicate|move|file|folder|disk\s+item|alias|POSIX)\b",
    re.IGNORECASE,
)
APPLESCRIPT_TARGET = re.compile(r'\b(?:application|app)\s+(?:id\s+)?"([^"]*)"', re.IGNORECASE)
APPLESCRIPT_PROCESS = re.compile(r'\bprocess\s+"([^"]*)"', re.IGNORECASE)
SCREENCAPTURE_FLAGS = {"-x", "-C", "-o", "-m", "-D", "-t", "-R", "-l"}  # -t/-R/-l/-D take a value
SCREENCAPTURE_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf", ".tiff"}


def _single_command(command: str) -> list[str] | None:
    """The command's words, or None if it chains, pipes, redirects or substitutes."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return None
    if not tokens or any(t and set(t) <= set("|&<>();") for t in tokens):
        return None
    if any("`" in t or "$(" in t for t in tokens):
        return None
    return tokens


def _same_app(name: str, app: str) -> bool:
    norm = lambda n: n.strip().removesuffix(".app").casefold()  # noqa: E731
    return norm(name) == norm(app)


def _osascript_reason(args: list[str], app: str) -> str | None:
    scripts = []
    i = 0
    while i < len(args):
        if args[i] == "-e" and i + 1 < len(args):
            scripts.append(args[i + 1])
            i += 2
        else:
            return "osascript is only allowed with -e scripts (no script files or other flags)"
    if not scripts:
        return "osascript needs an -e script"
    script = "\n".join(scripts)
    if APPLESCRIPT_FORBIDDEN.search(re.sub(r'"[^"]*"', '""', script)):
        return "AppleScript may only drive the app's UI (no shell, script, file or URL commands)"
    targets = APPLESCRIPT_TARGET.findall(script)
    processes = APPLESCRIPT_PROCESS.findall(script)
    if not targets:
        return f'AppleScript must tell application "{app}" or System Events'
    for t in targets:
        if not (_same_app(t, app) or t.casefold() == "system events"):
            return f'AppleScript may only target "{app}" or System Events (tried "{t}")'
    if any(t.casefold() == "system events" for t in targets) and not processes:
        return f'System Events must be scoped to process "{app}"'
    for proc in processes:
        if not _same_app(proc, app):
            return f'System Events may only drive process "{app}" (tried "{proc}")'
    return None


def _screencapture_reason(args: list[str], scratch: Path) -> str | None:
    paths, i = [], 0
    while i < len(args):
        a = args[i]
        if a in SCREENCAPTURE_FLAGS:
            i += 2 if a in ("-t", "-R", "-l", "-D") else 1
        elif a.startswith("-"):
            return f"screencapture flag {a} is not allowed"
        else:
            paths.append(a)
            i += 1
    if len(paths) != 1:
        return "screencapture needs exactly one output file"
    if Path(paths[0]).suffix.lower() not in SCREENCAPTURE_SUFFIXES or not _inside(paths[0], scratch):
        return f"screenshots may only be saved as images inside {scratch}"
    return None


def ui_reason(command: str, scratch: Path, ui: UiScope | None) -> str | None:
    """For a UI command (osascript, screencapture, cliclick): why it's refused, or None.

    Raises LookupError if the command isn't a UI command at all.
    """
    tokens = _single_command(command)
    tool = Path(tokens[0]).name if tokens else ""
    if tool not in UI_TOOLS:
        raise LookupError(command)
    if ui is None:
        return "UI automation is off for this run"
    if tool == "osascript":
        return _osascript_reason(tokens[1:], ui.app)
    if tool == "screencapture":
        return _screencapture_reason(tokens[1:], scratch)
    if "-f" in tokens[1:]:
        return "cliclick may not read commands from a file"
    return None


def is_ui_command(command: str) -> bool:
    tokens = _single_command(command)
    if tokens:
        return Path(tokens[0]).name in UI_TOOLS
    # A chained or piped UI command is still a UI command (and gets refused).
    return any(re.search(rf"(^|[\s;&|/]){tool}\b", command) for tool in UI_TOOLS)


PATCH_PATH = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", re.MULTILINE)


def deny_reason(confirmation: Mapping, scratch: Path, ui: UiScope | None = None) -> str | None:
    """Why the policy refuses one raw confirmation from droid, or None to allow it."""
    kind = confirmation.get("type")
    if kind == "exec":
        command = confirmation.get("fullCommand") or confirmation.get("command") or ""
        # UI tools are checked before the read-only shortcut, whatever droid rates them.
        if is_ui_command(command):
            try:
                reason = ui_reason(command, scratch, ui)
            except LookupError:
                reason = "UI commands must run on their own (no chaining, pipes or redirects)"
            return f"{reason} (tried {command!r})" if reason else None
        if confirmation.get("impactLevel") == "low":
            return None
        if _runs_scratch_scripts(command, scratch):
            return None
        also = ", or the UI commands described in your instructions" if ui else ""
        return (
            "only read-only commands, or running a Python script from the working "
            f"folder{also}, are allowed (tried {command!r})"
        )
    if kind in ("edit", "create"):
        paths = [confirmation.get("filePath")]
    elif kind == "apply_patch":
        paths = [confirmation.get("filePath")]
        for f in confirmation.get("files") or ():
            paths += [f.get("filePath"), f.get("moveTo")]
        paths += PATCH_PATH.findall(confirmation.get("patchContent") or "")
        paths = [p for p in paths if p] or [None]
    elif kind == "exit_spec_mode":
        return None
    else:
        return f"{kind} actions are not allowed in this session"
    outside = [str(p) for p in paths if not _inside(p, scratch)]
    if outside:
        return f"writes are only allowed inside {scratch} (tried {', '.join(outside)})"
    return None


def _confirmations(raw: Mapping) -> Iterator[Mapping]:
    """Each thing droid wants approved, unpacking calls batched inside a Script."""
    for tool_use in raw.get("toolUses") or ():
        details = tool_use.get("details") or {}
        if details.get("type") == "script":
            for call in details.get("calls") or ():
                # Calls without a confirmation (reads, todos) need no approval.
                if call.get("confirmation"):
                    yield call["confirmation"]
        else:
            yield details


def make_permission_handler(scratch: Path, emit: Emit, ui: UiScope | None = None):
    def raw_policy(raw: Mapping) -> dict:
        offered = [o.get("value") for o in raw.get("options") or ()]
        confirmations = list(_confirmations(raw))
        for confirmation in confirmations:
            reason = deny_reason(confirmation, scratch, ui)
            if reason:
                emit("denied", "Blocked agent action", reason)
                return {"selectedOption": "cancel", "comment": reason}
        # Every UI action that goes through is logged, so the run shows what was clicked.
        for confirmation in confirmations:
            command = confirmation.get("fullCommand") or confirmation.get("command") or ""
            if confirmation.get("type") == "exec" and is_ui_command(command):
                emit("ui", "UI action", _short(command, 600))
        return {"selectedOption": "proceed_once" if "proceed_once" in offered else "cancel"}

    def on_permission(request: PermissionRequest) -> PermissionResponse:
        # Unreachable while the dispatcher patch below is installed; refuse to be safe.
        return request.respond(ToolConfirmationOutcome.CANCEL)

    on_permission.raw_policy = raw_policy  # type: ignore[attr-defined]
    return on_permission


# droid-sdk 0.5.0 can't parse the "script" permission requests the droid CLI sends
# for Script tool calls, and cancels them before our handler runs. Handlers that
# carry a raw_policy see the raw request instead; everything else is unchanged.
_sdk_handle_permission = InteractionDispatcher.handle_permission


async def _handle_permission(self: InteractionDispatcher, raw: Mapping[str, object]) -> dict[str, object]:
    policy = getattr(self.handlers.on_permission, "raw_policy", None)
    if policy is None:
        return await _sdk_handle_permission(self, raw)
    try:
        return policy(raw)
    except Exception:
        self._report("Permission")
        return {"selectedOption": "cancel"}


InteractionDispatcher.handle_permission = _handle_permission


NO_ONE_HERE = (
    "No one is available to answer during this session. Decide using your instructions. "
    "If you can't continue safely, record why in your deliverable and finish."
)


def make_question_handler(emit: Emit):
    """Droid's AskUser has no human behind it here; answer so the agent decides and keeps going."""

    def on_question(request: QuestionRequest) -> QuestionResponse:
        for q in request.questions:
            emit("info", "Asked a question (no one to answer)", _short(q.question))
        return request.submit([q.answer(NO_ONE_HERE) for q in request.questions])

    return on_question


def _short(value: object, limit: int = 240) -> str:
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _describe_tool_call(event: ToolCall) -> str:
    data = event.input if isinstance(event.input, Mapping) else {}
    for key in ("command", "file_path", "path", "pattern", "query"):
        if key in data:
            return _short(data[key])
    return _short(event.input)


async def run_agent(
    app: str,
    data_path: Path,
    workspace: Path,
    emit: Emit,
    error: list[str] | None = None,
    ui: UiScope | None = None,
    prompt: str | None = None,
    done: tuple[str, ...] = (SCRIPT,),
    name: str = AGENT_NAME,
) -> bool:
    """Run one agent session: the extractor prompt unless another is given. It's nudged on
    after a refusal until one of the `done` files exists. Returns whether its last turn
    finished cleanly."""
    denials: list[str] = []

    def tracked_emit(kind: str, label: str, detail: str) -> None:
        if kind == "denied":
            denials.append(detail)
        emit(kind, f"{name}: {label}", detail)

    config = SessionConfig(autonomy=Autonomy.OFF)
    interactions = InteractionHandlers(
        on_permission=make_permission_handler(workspace, tracked_emit, ui),
        on_question=make_question_handler(tracked_emit),
    )
    prompt = prompt or build_prompt(app, data_path, workspace, error, ui)
    async with Session(cwd=workspace, config=config, interactions=interactions) as session:
        for nudge in range(MAX_NUDGES + 1):
            seen = len(denials)
            async with session.stream(prompt, timeout=AGENT_TIMEOUT_SECONDS) as stream:
                async for event in stream:
                    if isinstance(event, ToolCall):
                        emit("agent", f"{name}: {event.name}", _describe_tool_call(event))
                    elif isinstance(event, ToolResult) and event.is_error:
                        emit("agent", f"{name}: {event.tool_name} error", _short(event.content))
                    elif isinstance(event, AssistantMessage) and event.text.strip():
                        emit("agent", f"{name} says", _short(event.text, 600))
                    elif isinstance(event, ErrorEvent):
                        emit("error", f"{name} error", _short(event.message))
            result = stream.result

            # A refused action ends droid's turn; send it back to work once more.
            if len(denials) == seen or any((workspace / f).exists() for f in done) or nudge == MAX_NUDGES:
                break
            emit("info", f"{name} stopped after a refused action", "asking it to continue another way")
            prompt = NUDGE.format(reason=denials[-1], script=done[0])

    if not result.success:
        emit("error", f"{name} session failed", _short(f"{result.subtype} {result.error or ''}"))
    return result.success
