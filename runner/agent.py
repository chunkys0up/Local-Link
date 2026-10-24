"""Droid agent sessions: one writes extract.py, a separate one writes reference.py.

The two never share a folder or see each other's code, so the reference is a real
second opinion on the extractor rather than something tuned to agree with it.
"""

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
    Session,
    SessionConfig,
    ToolCall,
    ToolConfirmationOutcome,
    ToolResult,
)
from droid_sdk._high_level.interaction_adapter import InteractionDispatcher

Emit = Callable[[str, str, str], None]  # (kind, label, detail)

AGENT_TIMEOUT_SECONDS = 15 * 60

ACCOUNT_FORMAT = (
    'the account\'s full path from its top-level account, levels joined by ":" '
    '(e.g. "Expenses:Office:Rent"), with names exactly as the app shows them'
)

ACCESS = """\
## Access
- The data path is READ-ONLY. Never create, modify, move or delete anything there.
  Open databases read-only (SQLite: sqlite3.connect("file:<path>?mode=ro", uri=True)).
- Your working folder is {workspace}. Write files only there.
- Commands are limited to read-only ones, or `python <script>.py` for a script in the
  working folder. Anything else is refused. To run other programs (for example the
  app's own CLI to get its reports), call them from a .py script in the working folder
  with subprocess, and run that script.
- If you run the app itself on the data, run it on a copy of the data inside the working
  folder, with HOME and any config/cache dirs pointed into the working folder, so the
  app can't write lock files or settings next to the real data.
- If an action is refused, don't stop: take an allowed route and keep going.

## Rules
- Python 3 standard library only. No network.
- Your script prints only JSON to stdout.
- Run it against the data path to confirm it works before you finish.
- Finish with a short summary of the data format and how your script works.
"""

EXTRACT_TASK = """\
Connect to the local accounting app "{app}". Its data is at:

    {data_path}

Write an extractor that outputs normalized rows. A separate agent independently gets
reference totals from the app itself, and a checker compares the two.

## Deliverable: extract.py in the working folder
Run as: python extract.py <data_path>
Prints to stdout a JSON array with one object per posting line (split), every
transaction included. Each object has exactly these keys:
- date: "YYYY-MM-DD"
- account: {account_format}
- amount: positive decimal string with 2 places, e.g. "50.00"
- side: "debit" or "credit"
- memo: string, may be empty
- source: where in the app the row came from, e.g. "transactions/<id>"
Do not drop, net, merge or adjust entries.

{access}
## Work fast
- Inspect the data with a few quick commands, write the script, run it, and stop.
- Don't build validation harnesses, probe suites or READMEs; the pipeline checks
  your output.
"""

REFERENCE_TASK = """\
Connect to the local accounting app "{app}". Its data is at:

    {data_path}

Write a way to get reference totals from the app itself. A separate agent writes an
extractor that reads the raw data; your numbers are the independent check on it, so
get them from the app's own logic (its reports, stored balances, summary tables, or
its own CLI), not by parsing the raw data the way an extractor would. Only if the app
truly has no way to report totals, compute them from the data and say so clearly in
your summary.

## Deliverable: reference.py in the working folder
Run as: python reference.py <data_path>
Prints to stdout JSON:
{{"row_count": <int>, "total_debits": "<0.00>", "total_credits": "<0.00>",
 "accounts": {{"<account>": "<balance>", ...}}}}
- row_count: number of posting lines (splits) across all transactions
- total_debits / total_credits: gross totals across all posting lines
- accounts: every account that has postings, keyed by {account_format};
  balance = that account's debits minus credits, as a signed decimal string with
  2 places (e.g. "-50.00")

{access}
## Work fast
- Inspect the data with a few quick commands, then write the script.
- Use the app's documented interfaces first: its CLI `--help`, and its built-in report
  or export commands. Don't read the app's source code unless those don't work.
- Don't build validation harnesses, probe suites or READMEs; the pipeline checks
  your output. Once your script prints valid output, stop.
"""

REPAIR = """
## Previous attempt failed the checker
Your {script} is already in the working folder. The pipeline compared the extractor's
rows with the independent reference, and the checker rejected the result:
{differences}

You can't see the other side's code. Work out whether YOUR script misreports {truth},
or whether the books themselves have a real problem. Fix your script only if it is
wrong. Never hide, drop or alter entries, and never change numbers just to make them
match. If your script is right, leave it and explain why in your summary.
"""

NUDGE = """\
Your last action was refused by the session policy: {reason}

That doesn't end the task. Take an allowed route (read-only commands, or write a .py
script in the working folder and run it with python) and finish {script}.
"""

MAX_NUDGES = 2


@dataclass(frozen=True)
class Role:
    script: str
    name: str  # shown in events
    task: str
    truth: str  # what the script must faithfully report, for the repair prompt


ROLES = {
    "extract": Role("extract.py", "Extractor agent", EXTRACT_TASK, "the app's data"),
    "reference": Role("reference.py", "Reference agent", REFERENCE_TASK, "what the app itself reports"),
}

PYTHON = re.compile(r"^python3?(?:\.\d+)?$")


def build_prompt(
    role: Role, app: str, data_path: Path, workspace: Path, error: list[str] | None
) -> str:
    prompt = role.task.format(
        app=app,
        data_path=data_path,
        account_format=ACCOUNT_FORMAT,
        access=ACCESS.format(workspace=workspace),
    )
    if error:
        prompt += REPAIR.format(
            script=role.script,
            truth=role.truth,
            differences="\n".join(f"- {d}" for d in error),
        )
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
    role_key: str,
    app: str,
    data_path: Path,
    workspace: Path,
    emit: Emit,
    error: list[str] | None = None,
) -> bool:
    """Run one agent session for a role. Returns whether its last turn finished cleanly."""
    role = ROLES[role_key]
    denials: list[str] = []

    def tracked_emit(kind: str, label: str, detail: str) -> None:
        if kind == "denied":
            denials.append(detail)
        emit(kind, f"{role.name}: {label}", detail)

    config = SessionConfig(autonomy=Autonomy.OFF)
    interactions = InteractionHandlers(
        on_permission=make_permission_handler(workspace, tracked_emit)
    )
    prompt = build_prompt(role, app, data_path, workspace, error)
    async with Session(cwd=workspace, config=config, interactions=interactions) as session:
        for nudge in range(MAX_NUDGES + 1):
            seen = len(denials)
            async with session.stream(prompt, timeout=AGENT_TIMEOUT_SECONDS) as stream:
                async for event in stream:
                    if isinstance(event, ToolCall):
                        emit("agent", f"{role.name}: {event.name}", _describe_tool_call(event))
                    elif isinstance(event, ToolResult) and event.is_error:
                        emit("agent", f"{role.name}: {event.tool_name} error", _short(event.content))
                    elif isinstance(event, AssistantMessage) and event.text.strip():
                        emit("agent", f"{role.name} says", _short(event.text, 600))
                    elif isinstance(event, ErrorEvent):
                        emit("error", f"{role.name} error", _short(event.message))
            result = stream.result

            # A refused action ends droid's turn; send it back to work once more.
            done = (workspace / role.script).exists()
            if len(denials) == seen or done or nudge == MAX_NUDGES:
                break
            emit("info", f"{role.name} stopped after a refused action", "asking it to continue another way")
            prompt = NUDGE.format(reason=denials[-1], script=role.script)

    if not result.success:
        emit("error", f"{role.name} session failed", _short(f"{result.subtype} {result.error or ''}"))
    return result.success
