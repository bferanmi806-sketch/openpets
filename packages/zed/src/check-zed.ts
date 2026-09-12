import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildZedMcpEntry,
  formatZedMcpConfig,
  getZedGlobalSettingsDir,
  getZedGlobalSettingsPath,
  isValidOpenPetsPackageVersion,
  isValidPetId,
  validateOpenPetsPackageVersion,
  validateOpenPetsPetId,
} from "./zed-mcp.js";
import {
  classifyZedMcpStatus,
  executeZedMcpWrite,
  isManagedOpenPetsMcpEntry,
  maxZedSettingsBytes,
  parseZedSettings,
  planZedMcpInstall,
  planZedMcpRemove,
  planZedMcpReplace,
  readZedSettings,
  updateZedSettingsText,
  type ZedPlannedWrite,
} from "./zed-status.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "openpets-zed-")));
const expected = { mcpVersion: "3.3.0", petId: "fixer" };

function settingsPath(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return join(dir, "settings.json");
}

function writeSettings(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function tryCreateSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  }
}

function executePlan(plan: ReturnType<typeof planZedMcpInstall> | ReturnType<typeof planZedMcpRemove> | ReturnType<typeof planZedMcpReplace>): asserts plan is { readonly targetPath: string; readonly backupPath?: string; readonly tempPath: string; readonly sourceExists: boolean; readonly sourceContent: string; readonly content: string } {
  assert.equal("targetPath" in plan, true);
  if ("targetPath" in plan) executeZedMcpWrite(plan);
}

function writeInterruptedLock(plan: ZedPlannedWrite, lockPath: string, lockTempPath: string): void {
  const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
  writeSettings(lockPath, JSON.stringify({
    version: 1,
    token: "interrupted-test-write",
    pid: 999999999,
    lockTempPath,
    targetPath: plan.targetPath,
    ...(plan.backupPath ? { backupPath: plan.backupPath } : {}),
    tempPath: plan.tempPath,
    sourceExists: plan.sourceExists,
    sourceHash: hash(plan.sourceContent),
    contentHash: hash(plan.content),
  }));
}

try {
  // Path resolution follows Zed's platform-specific global settings locations.
  assert.equal(getZedGlobalSettingsDir({}, root, "darwin"), join(root, ".config", "zed"));
  assert.equal(getZedGlobalSettingsDir({ XDG_CONFIG_HOME: join(root, "xdg") }, root, "darwin"), join(root, ".config", "zed"));
  assert.equal(getZedGlobalSettingsPath({ XDG_CONFIG_HOME: join(root, "xdg") }, root, "linux"), join(root, "xdg", "zed", "settings.json"));
  assert.equal(getZedGlobalSettingsPath({ FLATPAK_XDG_CONFIG_HOME: join(root, "flatpak"), XDG_CONFIG_HOME: join(root, "xdg") }, root, "linux"), join(root, "flatpak", "zed", "settings.json"));
  assert.equal(getZedGlobalSettingsPath({ APPDATA: join(root, "appdata") }, root, "win32"), join(root, "appdata", "Zed", "settings.json"));

  // Pet and package inputs are bounded before they become command arguments.
  assert.equal(isValidPetId("fixer"), true);
  assert.equal(isValidPetId("bad/pet"), false);
  assert.equal(validateOpenPetsPetId("fixer"), "fixer");
  assert.throws(() => validateOpenPetsPetId("bad/pet"));
  assert.equal(validateOpenPetsPackageVersion("3.3.0-beta.1"), "3.3.0-beta.1");
  assert.throws(() => validateOpenPetsPackageVersion("latest"));
  assert.equal(isValidOpenPetsPackageVersion("1.2.3"), true);
  assert.equal(isValidOpenPetsPackageVersion("1.2.3+build.01"), true);
  assert.equal(isValidOpenPetsPackageVersion("01.2.3"), false);
  assert.equal(isValidOpenPetsPackageVersion("1.2.3-alpha..1"), false);

  const published = buildZedMcpEntry(expected);
  assert.deepEqual(published, {
    command: "npx",
    args: ["-y", "@open-pets/mcp@3.3.0", "--pet", "fixer"],
  });
  assert.deepEqual(buildZedMcpEntry({ mcpVersion: "3.3.0" }), {
    command: "npx",
    args: ["-y", "@open-pets/mcp@3.3.0"],
  });
  assert.deepEqual(formatZedMcpConfig(expected), { context_servers: { openpets: published } });

  const localEntryPath = join(root, "node_modules", "@open-pets", "mcp", "dist", "index.js");
  assert.deepEqual(buildZedMcpEntry({ ...expected, commandMode: "local", mcpEntryPath: localEntryPath }), {
    command: "node",
    args: [localEntryPath, "--pet", "fixer"],
  });
  assert.deepEqual(buildZedMcpEntry({ ...expected, commandMode: "bundled", mcpEntryPath: localEntryPath }), {
    command: "node",
    args: [localEntryPath, "--pet", "fixer"],
  });
  const customNodeCommand = join(root, "node-bin");
  const customLocalEntry = buildZedMcpEntry({ ...expected, commandMode: "bundled", mcpEntryPath: localEntryPath, nodeCommand: customNodeCommand });
  assert.equal(customLocalEntry.command, customNodeCommand);
  const customStatusPath = settingsPath("custom-node-status");
  writeSettings(customStatusPath, JSON.stringify({ context_servers: { openpets: customLocalEntry } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(customStatusPath), customStatusPath, { ...expected, commandMode: "bundled", mcpEntryPath: localEntryPath, nodeCommand: customNodeCommand }).status, "installed");
  assert.throws(() => buildZedMcpEntry({ ...expected, commandMode: "local", mcpEntryPath: "relative.js" }));

  // Clean install creates only the settings file and managed OpenPets entry.
  const cleanPath = settingsPath("clean-install");
  const cleanPlan = planZedMcpInstall(cleanPath, expected);
  executePlan(cleanPlan);
  const cleanText = readFileSync(cleanPath, "utf8");
  const cleanConfig = parseZedSettings(cleanText);
  assert.equal(cleanConfig.ok, true);
  if (cleanConfig.ok) assert.deepEqual((cleanConfig.value.context_servers as Record<string, unknown>).openpets, published);
  assert.equal(classifyZedMcpStatus(readZedSettings(cleanPath), cleanPath, expected).status, "installed");

  // JSONC comments, trailing commas, unrelated settings, and servers survive a targeted edit.
  const jsoncPath = settingsPath("jsonc-preservation");
  const jsoncSource = `{
  // user setting must survive
  "theme": "dark",
  "context_servers": {
    "other": {
      "command": "other-server",
      "args": [],
    },
  },
}`;
  writeSettings(jsoncPath, jsoncSource);
  const jsoncPlan = planZedMcpInstall(jsoncPath, expected);
  executePlan(jsoncPlan);
  const jsoncText = readFileSync(jsoncPath, "utf8");
  assert.match(jsoncText, /user setting must survive/);
  assert.match(jsoncText, /"theme": "dark"/);
  assert.match(jsoncText, /"other"/);
  assert.match(jsoncText, /"args": \[\],\s*\}/u);
  assert.equal(classifyZedMcpStatus(readZedSettings(jsoncPath), jsoncPath, expected).status, "installed");

  // Installed state distinguishes exact command and pet/version drift.
  const installedPath = settingsPath("installed");
  writeSettings(installedPath, JSON.stringify({ context_servers: { openpets: published } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(installedPath), installedPath, expected).status, "installed");

  const versionDriftPath = settingsPath("version-drift");
  writeSettings(versionDriftPath, JSON.stringify({ context_servers: { openpets: buildZedMcpEntry({ mcpVersion: "3.2.0", petId: "fixer" }) } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(versionDriftPath), versionDriftPath, expected).status, "needs-update");

  const petDriftPath = settingsPath("pet-drift");
  writeSettings(petDriftPath, JSON.stringify({ context_servers: { openpets: buildZedMcpEntry({ mcpVersion: "3.3.0", petId: "helper" }) } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(petDriftPath), petDriftPath, expected).status, "needs-update");

  const localStatusPath = settingsPath("local-status");
  const localStatusEntryPath = join(root, "local-mcp.js");
  writeSettings(localStatusPath, JSON.stringify({ context_servers: { openpets: { command: "node", args: [localStatusEntryPath, "--pet", "helper"] } } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(localStatusPath), localStatusPath, { ...expected, commandMode: "local", mcpEntryPath: localStatusEntryPath }).status, "needs-update");

  // Zed-specific optional fields are retained while a managed command is updated.
  const remotePath = settingsPath("remote-preserved");
  writeSettings(remotePath, JSON.stringify({ context_servers: {
    openpets: { ...buildZedMcpEntry({ mcpVersion: "3.2.0", petId: "helper" }), enabled: true, remote: true, env: { OPENPETS_DEBUG: "1" }, timeout: 30 },
  } }, null, 2));
  const remotePlan = planZedMcpInstall(remotePath, expected);
  executePlan(remotePlan);
  const remoteConfig = parseZedSettings(readFileSync(remotePath, "utf8"));
  assert.equal(remoteConfig.ok, true);
  if (remoteConfig.ok) {
    assert.deepEqual((remoteConfig.value.context_servers as Record<string, unknown>).openpets, {
      ...published,
      enabled: true,
      remote: true,
      env: { OPENPETS_DEBUG: "1" },
      timeout: 30,
    });
  }

  // A settings change after planning must not be overwritten by a stale plan.
  const concurrentPath = settingsPath("concurrent-change");
  const concurrentSource = JSON.stringify({ theme: "dark", context_servers: { other: { command: "other", args: [] } } }, null, 2);
  writeSettings(concurrentPath, concurrentSource);
  const stalePlan = planZedMcpInstall(concurrentPath, expected);
  assert.equal("targetPath" in stalePlan, true);
  writeSettings(concurrentPath, JSON.stringify({ theme: "light", context_servers: { other: { command: "other", args: [] } } }, null, 2));
  assert.throws(() => executePlan(stalePlan), /changed since this operation was previewed/);
  assert.match(readFileSync(concurrentPath, "utf8"), /"theme": "light"/);
  const emptyConcurrentPath = settingsPath("empty-concurrent-change");
  writeSettings(emptyConcurrentPath, "");
  const emptyStalePlan = planZedMcpInstall(emptyConcurrentPath, expected);
  assert.equal("targetPath" in emptyStalePlan, true);
  rmSync(emptyConcurrentPath);
  assert.throws(() => executePlan(emptyStalePlan), /changed since this operation was previewed/);
  assert.equal(existsSync(emptyConcurrentPath), false);

  // Unreadable lock metadata must fail closed and remain untouched.
  const lockedPath = settingsPath("locked");
  writeSettings(lockedPath, "{}\n");
  const lockedPlan = planZedMcpInstall(lockedPath, expected);
  const lockPath = join(root, "locked", ".openpets-zed.lock");
  writeSettings(lockPath, "active\n");
  assert.throws(() => executePlan(lockedPlan), /metadata is invalid/);
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath);

  // Disabled managed entries are visible and are never silently re-enabled by install.
  const disabledPath = settingsPath("disabled");
  const disabledSource = JSON.stringify({ context_servers: { openpets: { ...published, enabled: false } } }, null, 2);
  writeSettings(disabledPath, disabledSource);
  const disabledStatus = classifyZedMcpStatus(readZedSettings(disabledPath), disabledPath, expected);
  assert.equal(disabledStatus.status, "disabled");
  assert.equal(disabledStatus.canInstall, false);
  const disabledInstall = planZedMcpInstall(disabledPath, expected);
  assert.equal("ok" in disabledInstall && disabledInstall.ok === false, true);
  assert.equal(readFileSync(disabledPath, "utf8"), disabledSource);
  const disabledReplace = planZedMcpReplace(disabledPath, expected);
  executePlan(disabledReplace);
  const reenabled = parseZedSettings(readFileSync(disabledPath, "utf8"));
  assert.equal(reenabled.ok, true);
  if (reenabled.ok) assert.equal(((reenabled.value.context_servers as Record<string, unknown>).openpets as Record<string, unknown>).enabled, true);

  // An interrupted pre-commit transaction rolls back its support files before retrying.
  const interruptedPath = settingsPath("interrupted-before-commit");
  const interruptedSource = JSON.stringify({ theme: "dark", context_servers: { other: { command: "other", args: [] } } }, null, 2);
  writeSettings(interruptedPath, interruptedSource);
  const interruptedPlan = planZedMcpInstall(interruptedPath, expected);
  assert.equal("targetPath" in interruptedPlan, true);
  if ("targetPath" in interruptedPlan && interruptedPlan.backupPath) {
    writeSettings(interruptedPlan.tempPath, interruptedPlan.content);
    writeSettings(interruptedPlan.backupPath, interruptedPlan.sourceContent);
    const interruptedLockTemp = join(dirname(interruptedPlan.targetPath), ".openpets-zed-lock-interrupted.tmp");
    writeSettings(interruptedLockTemp, "stale lock owner");
    writeInterruptedLock(interruptedPlan, join(dirname(interruptedPlan.targetPath), ".openpets-zed.lock"), interruptedLockTemp);
    executePlan(interruptedPlan);
    assert.equal(readFileSync(interruptedPath, "utf8"), interruptedPlan.content);
    assert.equal(existsSync(interruptedPlan.tempPath), false);
    assert.equal(existsSync(interruptedPlan.backupPath), true);
    assert.equal(existsSync(interruptedLockTemp), false);
    assert.equal(existsSync(join(dirname(interruptedPlan.targetPath), ".openpets-zed.lock")), false);
  }

  // An interrupted post-commit transaction keeps the committed target and user backup.
  const committedPath = settingsPath("interrupted-after-commit");
  const committedSource = JSON.stringify({ theme: "dark", context_servers: { other: { command: "other", args: [] } } }, null, 2);
  writeSettings(committedPath, committedSource);
  const committedPlan = planZedMcpInstall(committedPath, expected);
  assert.equal("targetPath" in committedPlan, true);
  if ("targetPath" in committedPlan && committedPlan.backupPath) {
    writeSettings(committedPlan.backupPath, committedPlan.sourceContent);
    writeSettings(committedPath, committedPlan.content);
    const committedLockTemp = join(dirname(committedPlan.targetPath), ".openpets-zed-lock-committed.tmp");
    writeInterruptedLock(committedPlan, join(dirname(committedPlan.targetPath), ".openpets-zed.lock"), committedLockTemp);
    const retryPlan = planZedMcpRemove(committedPath);
    executePlan(retryPlan);
    assert.equal(existsSync(committedPlan.backupPath), true);
    assert.equal(readFileSync(committedPlan.backupPath, "utf8"), committedSource);
    assert.equal(existsSync(join(dirname(committedPlan.targetPath), ".openpets-zed.lock")), false);
  }

  // Recovery must not delete a backup that changed outside the journal.
  const tamperedPath = settingsPath("tampered-recovery-artifact");
  const tamperedSource = JSON.stringify({ theme: "dark" }, null, 2);
  writeSettings(tamperedPath, tamperedSource);
  const tamperedPlan = planZedMcpInstall(tamperedPath, expected);
  assert.equal("targetPath" in tamperedPlan, true);
  if ("targetPath" in tamperedPlan && tamperedPlan.backupPath) {
    writeSettings(tamperedPlan.backupPath, "changed backup\n");
    writeInterruptedLock(tamperedPlan, join(dirname(tamperedPlan.targetPath), ".openpets-zed.lock"), join(dirname(tamperedPlan.targetPath), ".openpets-zed-lock-tampered.tmp"));
    assert.throws(() => executePlan(tamperedPlan), /backup is missing or changed/);
    assert.equal(readFileSync(tamperedPath, "utf8"), tamperedSource);
    assert.equal(readFileSync(tamperedPlan.backupPath, "utf8"), "changed backup\n");
    rmSync(join(dirname(tamperedPlan.targetPath), ".openpets-zed.lock"), { force: true });
    rmSync(tamperedPlan.backupPath, { force: true });
  }

  // The old move-first failure shape restores the original before accepting a fresh plan.
  const movedPath = settingsPath("interrupted-move");
  const movedSource = JSON.stringify({ theme: "dark", context_servers: { other: { command: "other", args: [] } } }, null, 2);
  writeSettings(movedPath, movedSource);
  const movedPlan = planZedMcpInstall(movedPath, expected);
  assert.equal("targetPath" in movedPlan, true);
  if ("targetPath" in movedPlan && movedPlan.backupPath) {
    rmSync(movedPath);
    writeSettings(movedPlan.backupPath, movedPlan.sourceContent);
    writeSettings(movedPlan.tempPath, movedPlan.content);
    writeInterruptedLock(movedPlan, join(dirname(movedPlan.targetPath), ".openpets-zed.lock"), join(dirname(movedPlan.targetPath), ".openpets-zed-lock-moved.tmp"));
    const staleMissingPlan = planZedMcpInstall(movedPath, expected);
    assert.equal("targetPath" in staleMissingPlan, true);
    assert.throws(() => executePlan(staleMissingPlan), /changed since this operation was previewed/);
    assert.equal(readFileSync(movedPath, "utf8"), movedSource);
    const freshPlan = planZedMcpInstall(movedPath, expected);
    executePlan(freshPlan);
    assert.equal(classifyZedMcpStatus(readZedSettings(movedPath), movedPath, expected).status, "installed");
  }

  // An active owner is never mistaken for a stale lock or overwritten.
  const heldPath = settingsPath("held-lock");
  const heldSource = JSON.stringify({ theme: "dark" }, null, 2);
  writeSettings(heldPath, heldSource);
  const heldPlan = planZedMcpInstall(heldPath, expected);
  assert.equal("targetPath" in heldPlan, true);
  if ("targetPath" in heldPlan) {
    const heldLockPath = join(dirname(heldPlan.targetPath), ".openpets-zed.lock");
    writeInterruptedLock(heldPlan, heldLockPath, join(dirname(heldPlan.targetPath), ".openpets-zed-lock-held.tmp"));
    const heldLock = JSON.parse(readFileSync(heldLockPath, "utf8")) as Record<string, unknown>;
    writeSettings(heldLockPath, JSON.stringify({ ...heldLock, pid: process.pid }));
    assert.throws(() => executePlan(heldPlan), /EEXIST/);
    assert.equal(readFileSync(heldPath, "utf8"), heldSource);
    assert.equal(existsSync(heldLockPath), true);
    rmSync(heldLockPath);
  }

  // A non-OpenPets server occupying the key is a conflict and is not overwritten by install.
  const conflictPath = settingsPath("conflict");
  const conflictSource = JSON.stringify({ context_servers: { openpets: { command: "custom-server", args: ["serve"] } } }, null, 2);
  writeSettings(conflictPath, conflictSource);
  assert.equal(classifyZedMcpStatus(readZedSettings(conflictPath), conflictPath, expected).status, "conflict");
  const conflictPlan = planZedMcpInstall(conflictPath, expected);
  assert.equal("ok" in conflictPlan && conflictPlan.ok === false, true);
  assert.equal(readFileSync(conflictPath, "utf8"), conflictSource);

  const malformedEntryPath = settingsPath("malformed-entry");
  writeSettings(malformedEntryPath, JSON.stringify({ context_servers: { openpets: null } }, null, 2));
  assert.equal(classifyZedMcpStatus(readZedSettings(malformedEntryPath), malformedEntryPath, expected).status, "invalid");

  // Malformed JSONC is invalid and cannot produce a write plan.
  const malformedPath = settingsPath("malformed");
  writeSettings(malformedPath, "{\n  \"context_servers\": {\n");
  assert.equal(classifyZedMcpStatus(readZedSettings(malformedPath), malformedPath, expected).status, "invalid");
  const malformedPlan = planZedMcpInstall(malformedPath, expected);
  assert.equal("ok" in malformedPlan && malformedPlan.ok === false, true);
  assert.equal(readFileSync(malformedPath, "utf8"), "{\n  \"context_servers\": {\n");

  // Unsafe/symlink targets are rejected before any mutation.
  const unsafePath = `${root}\\..\\unsafe\\settings.json`;
  const unsafeRead = readZedSettings(unsafePath);
  assert.equal(unsafeRead.ok, false);
  if (!unsafeRead.ok) assert.equal(unsafeRead.reason, "unsafe-path");

  const symlinkDir = join(root, "symlinks");
  mkdirSync(symlinkDir);
  const realSettings = join(symlinkDir, "real.json");
  const linkedSettings = join(symlinkDir, "linked.json");
  writeSettings(realSettings, "{}");
  const realParent = join(symlinkDir, "real-parent");
  const linkedParent = join(symlinkDir, "linked-parent");
  mkdirSync(realParent);
  if (tryCreateSymlink(realSettings, linkedSettings) && tryCreateSymlink(realParent, linkedParent)) {
    const symlinkRead = readZedSettings(linkedSettings);
    assert.equal(symlinkRead.ok, false);
    if (!symlinkRead.ok) assert.equal(symlinkRead.reason, "symlink");

    const linkedParentPath = join(linkedParent, "settings.json");
    const linkedParentPlan = planZedMcpInstall(linkedParentPath, expected);
    assert.equal("ok" in linkedParentPlan && linkedParentPlan.ok === false, true);
  }

  const directoryPath = join(symlinkDir, "directory-settings.json");
  mkdirSync(directoryPath);
  const directoryRead = readZedSettings(directoryPath);
  assert.equal(directoryRead.ok, false);
  if (!directoryRead.ok) assert.equal(directoryRead.reason, "not-regular");

  const oversizedPath = settingsPath("oversized");
  writeSettings(oversizedPath, `{"value":"${"x".repeat(maxZedSettingsBytes)}"}`);
  const oversizedRead = readZedSettings(oversizedPath);
  assert.equal(oversizedRead.ok, false);
  if (!oversizedRead.ok) assert.equal(oversizedRead.reason, "size");

  // Removal targets only context_servers.openpets and keeps all other content.
  const removePath = settingsPath("remove");
  const removeSource = `{
  // keep this comment
  "otherSetting": true,
  "context_servers": {
    "openpets": ${JSON.stringify(published)},
    "other": { "command": "other", "args": [] },
  },
}`;
  writeSettings(removePath, removeSource);
  const removePlan = planZedMcpRemove(removePath);
  executePlan(removePlan);
  const removedText = readFileSync(removePath, "utf8");
  assert.match(removedText, /keep this comment/);
  assert.match(removedText, /"otherSetting": true/);
  const removedConfig = parseZedSettings(removedText);
  assert.equal(removedConfig.ok, true);
  if (removedConfig.ok) {
    const servers = removedConfig.value.context_servers as Record<string, unknown>;
    assert.equal(servers.openpets, undefined);
    assert.deepEqual(servers.other, { command: "other", args: [] });
  }

  // Published, local, bundled, and unpinned command detection stays explicit.
  assert.equal(isManagedOpenPetsMcpEntry(published), true);
  assert.equal(isManagedOpenPetsMcpEntry(buildZedMcpEntry({ ...expected, commandMode: "local", mcpEntryPath: localEntryPath })), true);
  assert.equal(isManagedOpenPetsMcpEntry({ command: "npx", args: ["-y", "@open-pets/mcp@latest"] }), false);
  assert.equal(isManagedOpenPetsMcpEntry({ command: "node", args: ["relative/packages/mcp/dist/index.js"] }), false);

  // Direct JSONC edits reject malformed input without returning a mutation.
  assert.equal(typeof updateZedSettingsText(`{ "theme": "dark", }`, ["context_servers", "openpets"], published), "string");
  const invalidEdit = updateZedSettingsText("{", ["context_servers", "openpets"], published);
  assert.equal(typeof invalidEdit, "object");
  if (typeof invalidEdit !== "string") assert.equal(invalidEdit.ok, false);

  console.error("Zed validation passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
