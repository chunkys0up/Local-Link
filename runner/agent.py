"""Droid agent session that writes extract.py into its own temp folder."""

import re
import shlex
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path

from droid_sdk import (
    AssistantMessage,
    Autonomy,
    ErrorEvent,
    InteractionHandlers,
    PermissionRequest,
    PermissionResponse,
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

NUDGE = """\
Your last action was refused by the session policy: {reason}

That doesn't end the task. Take an allowed route (read-only commands, or write a .py
script in the working folder and run it with python) and finish extract.py.
"""

MAX_NUDGES = 2
AGENT_NAME = "Extractor agent"
SCRIPT = "extract.py"

PYTHON = re.compile(r"^python3?(?:\.\d+)?$")


def build_prompt(app: str, data_path: Path, workspace: Path, error: list[str] | None) -> str:
    prompt = PROMPT.format(app=app, data_path=data_path, workspace=workspace)
    if error:
        prompt += REPAIR.format(differences="\n".join(f"- {d}" for d in error))
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


PATCH_PATH = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", re.MULTILINE)


def deny_reason(confirmation: Mapping, scratch: Path) -> str | None:
    """Why the policy refuses one raw confirmation from droid, or None to allow it."""
    kind = confirmation.get("type")
    if kind == "exec":
        if confirmation.get("impactLevel") == "low":
            return None
        command = confirmation.get("fullCommand") or confirmation.get("command") or ""
        if _runs_scratch_scripts(command, scratch):
            return None
        return (
            "only read-only commands, or running a Python script from the working "
            f"folder, are allowed (tried {command!r})"
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


def make_permission_handler(scratch: Path, emit: Emit):
    def raw_policy(raw: Mapping) -> dict:
        offered = [o.get("value") for o in raw.get("options") or ()]
        for confirmation in _confirmations(raw):
            reason = deny_reason(confirmation, scratch)
            if reason:
                emit("denied", "Blocked agent action", reason)
                return {"selectedOption": "cancel", "comment": reason}
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
) -> bool:
    """Run one extractor agent session. Returns whether its last turn finished cleanly."""
    denials: list[str] = []

    def tracked_emit(kind: str, label: str, detail: str) -> None:
        if kind == "denied":
            denials.append(detail)
        emit(kind, f"{AGENT_NAME}: {label}", detail)

    config = SessionConfig(autonomy=Autonomy.OFF)
    interactions = InteractionHandlers(
        on_permission=make_permission_handler(workspace, tracked_emit)
    )
    prompt = build_prompt(app, data_path, workspace, error)
    async with Session(cwd=workspace, config=config, interactions=interactions) as session:
        for nudge in range(MAX_NUDGES + 1):
            seen = len(denials)
            async with session.stream(prompt, timeout=AGENT_TIMEOUT_SECONDS) as stream:
                async for event in stream:
                    if isinstance(event, ToolCall):
                        emit("agent", f"{AGENT_NAME}: {event.name}", _describe_tool_call(event))
                    elif isinstance(event, ToolResult) and event.is_error:
                        emit("agent", f"{AGENT_NAME}: {event.tool_name} error", _short(event.content))
                    elif isinstance(event, AssistantMessage) and event.text.strip():
                        emit("agent", f"{AGENT_NAME} says", _short(event.text, 600))
                    elif isinstance(event, ErrorEvent):
                        emit("error", f"{AGENT_NAME} error", _short(event.message))
            result = stream.result

            # A refused action ends droid's turn; send it back to work once more.
            if len(denials) == seen or (workspace / SCRIPT).exists() or nudge == MAX_NUDGES:
                break
            emit("info", f"{AGENT_NAME} stopped after a refused action", "asking it to continue another way")
            prompt = NUDGE.format(reason=denials[-1])

    if not result.success:
        emit("error", f"{AGENT_NAME} session failed", _short(f"{result.subtype} {result.error or ''}"))
    return result.success
