"""Droid agent session that writes extract.py and reference.py into a scratch folder."""

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

Write an extractor that outputs normalized rows, and write a separate way to get a
reference total from the app itself.

## Access
- The data path is READ-ONLY. Never create, modify, move or delete anything there.
  Open databases read-only (SQLite: sqlite3.connect("file:<path>?mode=ro", uri=True)).
- Your working folder is {scratch}. Write files only there.

## Deliverables (in the working folder)
1. extract.py, run as: python extract.py <data_path>
   Prints to stdout a JSON array with one object per posting line (split), every
   transaction included. Each object has exactly these keys:
   - date: "YYYY-MM-DD"
   - account: the full account name as the app shows it (e.g. "Expenses:Rent")
   - amount: positive decimal string with 2 places, e.g. "50.00"
   - side: "debit" or "credit"
   - memo: string, may be empty
   - source: where in the app the row came from, e.g. "transactions/<id>"
   Do not drop, net, merge or adjust entries.
2. reference.py, run as: python reference.py <data_path>
   Prints to stdout JSON: {{"row_count": <int>, "total_debits": "<0.00>", "total_credits": "<0.00>"}}
   Compute it independently of extract.py, from the app's own totals wherever possible
   (its reports, stored balances, summary tables, or its own CLI). Do not import or
   call extract.py.

## Rules
- Python 3 standard library only. No network.
- Scripts print only JSON to stdout.
- Run both scripts against the data path to confirm they work before you finish.
- Finish with a short summary of the data format and how each script works.
"""

REPAIR = """
## Previous attempt failed the checker
The scripts already in the working folder were checked and rejected:
{differences}

Work out whether the scripts are wrong or the books themselves have a real problem.
Fix the scripts if they are wrong. Never hide, drop or alter real entries, and never
change reference.py just to make the numbers match. If the books themselves are wrong,
keep the scripts honest and say so in your summary.
"""

PYTHON = re.compile(r"^python3?(?:\.\d+)?$")


def build_prompt(app: str, data_path: Path, scratch: Path, error: list[str] | None) -> str:
    prompt = PROMPT.format(app=app, data_path=data_path, scratch=scratch)
    if error:
        prompt += REPAIR.format(differences="\n".join(f"- {d}" for d in error))
    return prompt


def _inside(path: str | None, root: Path) -> bool:
    if not path:
        return False
    p = Path(path).expanduser()
    return (p if p.is_absolute() else root / p).resolve().is_relative_to(root)


def _runs_scratch_script(command: str, scratch: Path) -> bool:
    try:
        parts = shlex.split(command)
    except ValueError:
        return False
    if parts[:1] == ["cd"]:
        return True
    if parts[:2] == ["uv", "run"]:
        parts = parts[2:]
    if len(parts) < 2 or not PYTHON.match(Path(parts[0]).name):
        return False
    script = Path(parts[1])
    if script.suffix != ".py":
        return False
    return _inside(parts[1], scratch)


PATCH_PATH = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", re.MULTILINE)


def deny_reason(confirmation: Mapping, scratch: Path) -> str | None:
    """Why the policy refuses one raw confirmation from droid, or None to allow it."""
    kind = confirmation.get("type")
    if kind == "exec":
        if confirmation.get("impactLevel") == "low":
            return None
        command = confirmation.get("fullCommand") or confirmation.get("command") or ""
        commands = confirmation.get("extractedCommands") or [command]
        if all(_runs_scratch_script(c, scratch) for c in commands):
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
    scratch: Path,
    emit: Emit,
    error: list[str] | None = None,
) -> bool:
    """Run one agent session. Returns whether the session itself finished cleanly."""
    config = SessionConfig(autonomy=Autonomy.OFF)
    interactions = InteractionHandlers(
        on_permission=make_permission_handler(scratch, emit)
    )
    async with Session(cwd=scratch, config=config, interactions=interactions) as session:
        async with session.stream(
            build_prompt(app, data_path, scratch, error), timeout=AGENT_TIMEOUT_SECONDS
        ) as stream:
            async for event in stream:
                if isinstance(event, ToolCall):
                    emit("agent", f"Agent: {event.name}", _describe_tool_call(event))
                elif isinstance(event, ToolResult) and event.is_error:
                    emit("agent", f"Agent: {event.tool_name} error", _short(event.content))
                elif isinstance(event, AssistantMessage) and event.text.strip():
                    emit("agent", "Agent says", _short(event.text, 600))
                elif isinstance(event, ErrorEvent):
                    emit("error", "Agent error", _short(event.message))
        result = stream.result

    if not result.success:
        emit("error", "Agent session failed", _short(f"{result.subtype} {result.error or ''}"))
    return result.success
