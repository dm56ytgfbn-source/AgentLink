import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsAppFindCommand, parseWindowsAppFind, parseMacAppFind } from '../apps/runtime/app-find.js';

test('native app lookup quotes agent input as a PowerShell literal', () => {
  const command = windowsAppFindCommand("Blender'; Write-Output evil; '");
  assert.ok(command.includes("$q='Blender''; Write-Output evil; '''"));
  assert.throws(() => windowsAppFindCommand('Blender\nRemove-Item X'));
  assert.throws(() => windowsAppFindCommand('*'));
  assert.throws(() => windowsAppFindCommand(''));
});

test('Mac lookup returns only matching app bundles from standard locations', () => {
  const result = parseMacAppFind('/Applications/Safari.app\n/Applications/Utilities/Terminal.app\n/Applications/Safari.app\n', 'Mac', 'Safari');
  assert.deepEqual(result.matches, [{ name: 'Safari', source: 'applications_folder', command_path: '/Applications/Safari.app' }]);
});

test('native app lookup normalizes one hit and missing hits', () => {
  const hit = parseWindowsAppFind('{"name":"Blender 5.2","source":"start_menu","app_id":"D:\\\\Apps\\\\Blender.exe","version":null}', 'PC', 'Blender');
  assert.equal(hit.matches[0].name, 'Blender 5.2');
  assert.equal(hit.matches[0].source, 'start_menu');
  assert.equal(hit.matches[0].app_id, 'D:\\Apps\\Blender.exe');
  assert.deepEqual(parseWindowsAppFind('[]', 'PC', 'Missing').matches, []);
});
