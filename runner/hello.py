"""Hello-world Droid session: says hi and prints every streamed event."""

import asyncio
from pathlib import Path

from droid_sdk import Session, TextDelta


async def main() -> None:
    event_counts: dict[str, int] = {}

    async with Session(cwd=Path.cwd()) as session:
        async with session.stream(
            'Say hi. Reply with only the word "hi".',
            include_partial_messages=True,
            timeout=120,
        ) as stream:
            async for event in stream:
                name = type(event).__name__
                event_counts[name] = event_counts.get(name, 0) + 1
                if isinstance(event, TextDelta):
                    print(f"[{name}] {event.text!r}")
                else:
                    print(f"[{name}]")

        result = stream.result

    print(f"\nevent counts: {event_counts}")
    if not result.success:
        raise SystemExit(f"run failed: {result.subtype} {result.error}")
    print(f"droid said: {result.text!r}")


if __name__ == "__main__":
    asyncio.run(main())
