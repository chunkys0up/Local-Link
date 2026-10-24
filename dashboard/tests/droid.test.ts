import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@factory/droid-sdk/node';

test('droid is running and says hi', { timeout: 120_000 }, async () => {
  const result = await run('Say hi. Reply with only the word "hi".');

  assert.ok(result.success, result.error?.message ?? `Run failed: ${result.subtype}`);
  console.log(`droid said: ${result.text}`);
  assert.match(result.text, /\bhi\b/i);
});
