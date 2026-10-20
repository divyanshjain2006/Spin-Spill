/**
 * game.test.js
 *
 * Tests for the server-side game logic in server/src/services/game.js
 * Uses Node's built-in test runner (node:test) — no extra libraries needed.
 *
 * Run: npm run test -w server
 *
 * Test cases cover:
 *  1.  Friend-submitted tasks are selected when available
 *  2.  Selection is random (different tasks can be picked)
 *  3.  A skipped task is never selected again in the same cycle
 *  4.  All submitted Dares exhausted → fall back to built-in Dare
 *  5.  Exhausting Dares does NOT affect Truths
 *  6.  All submitted Truths exhausted → fall back to built-in Truth
 *  7.  Built-in tasks can also be skipped without infinite loop
 *  8.  Cycle resets when every built-in is also exhausted
 *  9.  Two draw calls (simulating two clients) see the same task (server-authoritative)
 * 10.  Tasks from different rooms never mix
 * 11.  Invalid/empty tasks are rejected at submission time
 * 12.  Concurrent selection: same task cannot be double-consumed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../src/services/game.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal room with a host and one friend already connected. */
function makeRoom(code = 'TEST01') {
  const room = game.createRoom('Host', 'host-token', code);
  room.players.push({ id: 'p2', name: 'Friend', token: 'friend-token', connected: true, isHost: false, joinedAt: Date.now() });
  return room;
}

/** Start the game, spin to a specific target, choose a category. */
function startRound(room, targetId, category = 'DARE') {
  const host = room.players[0];
  game.start(room, host);
  game.chooseTarget(room, host, targetId);
  const target = room.players.find(p => p.id === targetId);
  game.chooseCategory(room, target, category);
}

/** Submit a suggestion from a non-target player. */
function addSuggestion(room, authorPlayer, text, type) {
  game.submit(room, authorPlayer, text, type);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. Friend-submitted tasks are selected when available
test('friend-submitted task is drawn when one exists', () => {
  const room = makeRoom('R001');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Do a silly dance', 'DARE');
  const task = game.draw(room, friend);
  assert.equal(task.source, 'SUGGESTION', 'should pick the friend-submitted task');
  assert.equal(task.text, 'Do a silly dance');
});

// 2. Multiple submitted tasks — selection is random (not forced in order)
test('multiple submitted tasks: any of them can be picked', () => {
  const room = makeRoom('R002');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Dare A', 'DARE');
  addSuggestion(room, host, 'Dare B', 'DARE');
  addSuggestion(room, host, 'Dare C', 'DARE');
  // Run 30 draws (reset statuses between each) to verify non-determinism.
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    // Reset all tasks back to AVAILABLE before each draw.
    room.round.tasks.forEach(t => { t.status = 'AVAILABLE'; });
    room.phase = 'TASK_SUBMISSION';
    room.round.currentTaskId = undefined;
    const task = game.draw(room, friend);
    seen.add(task.text);
    if (seen.size === 3) break; // all three were seen
  }
  assert.equal(seen.size, 3, 'all three submitted tasks should be reachable');
});

// 3. Skipped task is not selected again during the same cycle
test('skipped task is excluded from subsequent draws', () => {
  const room = makeRoom('R003');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Skip Me', 'DARE');
  addSuggestion(room, host, 'Pick Me', 'DARE');
  // Draw and skip the first task.
  game.draw(room, friend);
  const firstTaskId = room.round.currentTaskId;
  game.resolve(room, friend, 'redraw');   // marks previous as SKIPPED, draws next
  // Whatever was drawn second must not be the first task.
  assert.notEqual(room.round.currentTaskId, firstTaskId, 'should not redraw the skipped task');
});

// 4. All submitted Dares exhausted → built-in Dare is used
test('built-in dare is used after all submitted dares are exhausted', () => {
  const room = makeRoom('R004');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Only Dare', 'DARE');
  // Draw and skip the only submitted dare.
  game.draw(room, friend);
  game.resolve(room, friend, 'redraw');
  // Now the pool should have moved to built-in tasks.
  const current = room.round.tasks.find(t => t.id === room.round.currentTaskId);
  assert.equal(current.source, 'BUILT_IN', 'should fall back to a built-in dare');
  assert.equal(current.type, 'DARE', 'fallback must be the correct type');
});

// 5. Exhausting Dares does NOT exhaust Truths
test('exhausting submitted dares leaves submitted truths untouched', () => {
  const room = makeRoom('R005');
  const host = room.players[0];
  const friend = room.players[1];
  // Pre-load both types of suggestions.
  // For this test we add the truth suggestions to room.suggestions directly,
  // since a round can only have one category.
  room.suggestions.push({ id: 'sub-truth-1', text: 'Truth 1', type: 'TRUTH', authorId: host.id, authorName: host.name, status: 'AVAILABLE', createdAt: Date.now() });
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Only Dare', 'DARE');
  // Exhaust the dare suggestions.
  game.draw(room, friend);
  game.resolve(room, friend, 'redraw'); // redraw: skip dare, move to built-in dare
  // Truth suggestions in room.suggestions must still be AVAILABLE.
  const truthSuggestions = room.suggestions.filter(s => s.type === 'TRUTH' && s.status === 'AVAILABLE');
  assert.ok(truthSuggestions.length > 0, 'truth suggestions must still be available');
});

// 6. All submitted Truths exhausted → built-in Truth is used
test('built-in truth is used after all submitted truths are exhausted', () => {
  const room = makeRoom('R006');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'TRUTH');
  addSuggestion(room, host, 'Only Truth', 'TRUTH');
  game.draw(room, friend);
  game.resolve(room, friend, 'redraw');
  const current = room.round.tasks.find(t => t.id === room.round.currentTaskId);
  assert.equal(current.source, 'BUILT_IN');
  assert.equal(current.type, 'TRUTH');
});

// 7. Built-in tasks can be skipped without infinite loop
test('skipping multiple built-in tasks eventually finds another one', () => {
  const room = makeRoom('R007');
  room.settings.sourceMode = 'BUILT_IN'; // force built-in only
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  // Draw the first task, then keep using resolve('redraw') which internally
  // calls draw() again — should never throw for at least 10 iterations.
  game.draw(room, friend);
  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(
      () => game.resolve(room, friend, 'redraw'),
      `iteration ${i} should not throw`
    );
    // After resolve('redraw') the phase is TASK_REVEALED (draw was called inside)
    // or TASK_SUBMISSION if the cycle reset. Either is valid.
    assert.ok(
      ['TASK_SUBMISSION', 'TASK_EXHAUSTED', 'TASK_REVEALED'].includes(room.phase),
      `unexpected phase at iteration ${i}: ${room.phase}`
    );
  }
});

// 8. Cycle resets when every built-in is exhausted (game must not get stuck)
test('game continues after full exhaustion by resetting availability', () => {
  const room = makeRoom('R008');
  room.settings.sourceMode = 'BUILT_IN';
  room.settings.builtInCount = 1; // very small pool to exhaust quickly
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  // Draw the first task to get into TASK_REVEALED.
  game.draw(room, friend);
  // Then keep redrawing — should never throw across 60 iterations.
  for (let i = 0; i < 60; i++) {
    assert.doesNotThrow(
      () => game.resolve(room, friend, 'redraw'),
      `iteration ${i} should not throw`
    );
  }
});

// 9. Server-authoritative: after draw(), currentTaskId is deterministic for a
//    given room state — both clients read the same task from room:update.
test('all clients see the same task after a draw', () => {
  const room = makeRoom('R009');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Shared Dare', 'DARE');
  game.draw(room, friend);
  // publicRoom returns the same currentTaskId to every viewer.
  const viewHost = game.publicRoom(room, host.id);
  const viewFriend = game.publicRoom(room, friend.id);
  assert.equal(viewHost.round.currentTaskId, viewFriend.round.currentTaskId, 'both clients see same currentTaskId');
});

// 10. Tasks from different rooms never mix
test('tasks from room A are not visible in room B', () => {
  const roomA = makeRoom('AAAAA1');
  const roomB = makeRoom('BBBBB2');
  const hostA = roomA.players[0];
  const hostB = roomB.players[0];
  roomA.players.push({ id: 'pA2', name: 'FriendA', token: 'tA2', connected: true, isHost: false, joinedAt: Date.now() });
  roomB.players.push({ id: 'pB2', name: 'FriendB', token: 'tB2', connected: true, isHost: false, joinedAt: Date.now() });
  startRound(roomA, 'pA2', 'DARE');
  startRound(roomB, 'pB2', 'DARE');
  addSuggestion(roomA, hostA, 'Room A exclusive dare', 'DARE');
  // Room B should have no suggestions from Room A.
  assert.equal(roomB.suggestions.length, 0, 'room B must have zero suggestions from room A');
});

// 11. Invalid/empty tasks are rejected at submission
test('empty and overlong tasks are rejected', () => {
  const room = makeRoom('R011');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  assert.throws(() => game.submit(room, host, '', 'DARE'), /1–300/);
  assert.throws(() => game.submit(room, host, '  ', 'DARE'), /1–300/);
  assert.throws(() => game.submit(room, host, 'x'.repeat(301), 'DARE'), /1–300/);
});

// 12. Concurrent selection: draw() changes status atomically so the same task
//     cannot be double-consumed in a single-threaded Node.js event loop.
test('two sequential draw calls do not select the same single task', () => {
  const room = makeRoom('R012');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Solo Dare', 'DARE');
  // First draw consumes the only friend task.
  game.draw(room, friend);
  const firstId = room.round.currentTaskId;
  // Reset phase manually (simulating a quick resolve→redraw within same event loop tick).
  room.round.tasks.find(t => t.id === firstId).status = 'SKIPPED';
  room.phase = 'TASK_SUBMISSION';
  // Second draw must produce a built-in (the friend task is SKIPPED).
  game.draw(room, friend);
  const secondId = room.round.currentTaskId;
  assert.notEqual(firstId, secondId, 'second draw must not repeat the skipped task');
  const second = room.round.tasks.find(t => t.id === secondId);
  assert.equal(second.source, 'BUILT_IN', 'second draw should be a built-in');
});

// ── Bonus: original spin test preserved ──────────────────────────────────────
test('a virtual spin creates a target and advances to category selection', () => {
  const room = game.createRoom('Host', 't1', 'SPIN01');
  room.players.push({ id: 'p2', name: 'Friend', token: 't2', connected: true });
  const host = room.players[0];
  game.start(room, host);
  game.spin(room, host);
  assert.equal(room.phase, 'CATEGORY_SELECTION');
  assert.ok(room.round.targetId);
});

// 14. Privacy: publicRoom strips authorId and authorName from suggestions and round tasks
test('publicRoom strips authorId and authorName from suggestions and round tasks', () => {
  const room = makeRoom('PRIV01');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'TRUTH');
  addSuggestion(room, host, 'A secret question', 'TRUTH');

  // Verify internal record preserves author for moderation/internal tracking
  assert.equal(room.suggestions[0].authorId, host.id);
  assert.equal(room.suggestions[0].authorName, host.name);

  // Draw task so it appears in room.round.tasks
  game.draw(room, friend);
  assert.equal(room.round.tasks[0].authorId, host.id);
  assert.equal(room.round.tasks[0].authorName, host.name);

  // Check public serialized state for ordinary players
  const publicState = game.publicRoom(room, friend.id);
  assert.equal(publicState.suggestions[0].authorId, undefined, 'authorId must not leak in suggestions');
  assert.equal(publicState.suggestions[0].authorName, undefined, 'authorName must not leak in suggestions');
  assert.equal(publicState.round.tasks[0].authorId, undefined, 'authorId must not leak in round tasks');
  assert.equal(publicState.round.tasks[0].authorName, undefined, 'authorName must not leak in round tasks');
});

// 15. Privacy: draw() returns sanitized task without authorId or authorName
test('draw() returns a sanitized task without author fields', () => {
  const room = makeRoom('PRIV02');
  const host = room.players[0];
  const friend = room.players[1];
  startRound(room, friend.id, 'DARE');
  addSuggestion(room, host, 'Secret dare task', 'DARE');

  const drawnTask = game.draw(room, friend);
  assert.equal(drawnTask.text, 'Secret dare task');
  assert.equal(drawnTask.source, 'SUGGESTION');
  assert.equal(drawnTask.authorId, undefined, 'drawn task must not include authorId');
  assert.equal(drawnTask.authorName, undefined, 'drawn task must not include authorName');
});

