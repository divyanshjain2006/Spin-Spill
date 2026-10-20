import test from 'node:test';
import assert from 'node:assert/strict';
import { io as Client } from 'socket.io-client';
import { server } from '../src/index.js';

let clientAlice;
let clientBob;

test.after(async () => {
  clientAlice?.disconnect();
  clientBob?.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('multiplayer socket flow: verify submitter anonymity and task synchronization', async () => {
  const port = server.address().port;
  const url = `http://localhost:${port}`;

  clientAlice = Client(url);
  clientBob = Client(url);

  // 1. Alice creates room
  const createRes = await new Promise((resolve) => {
    clientAlice.emit('room:create', { name: 'Alice' }, resolve);
  });
  assert.equal(createRes.ok, true);
  const roomCode = createRes.code;
  const aliceId = createRes.playerId;
  const aliceToken = createRes.token;

  // 2. Bob joins room
  const joinRes = await new Promise((resolve) => {
    clientBob.emit('room:join', { code: roomCode, name: 'Bob' }, resolve);
  });
  assert.equal(joinRes.ok, true);
  const bobId = joinRes.playerId;
  const bobToken = joinRes.token;

  // 3. Alice starts game
  const startRes = await new Promise((resolve) => {
    clientAlice.emit('game:start', { code: roomCode, playerId: aliceId, token: aliceToken }, resolve);
  });
  assert.equal(startRes.ok, true);

  // 4. Alice chooses Bob as target
  const targetRes = await new Promise((resolve) => {
    clientAlice.emit('game:target', { code: roomCode, playerId: aliceId, token: aliceToken, targetId: bobId }, resolve);
  });
  assert.equal(targetRes.ok, true);

  // 5. Bob chooses TRUTH
  const catRes = await new Promise((resolve) => {
    clientBob.emit('game:category', { code: roomCode, playerId: bobId, token: bobToken, type: 'TRUTH' }, resolve);
  });
  assert.equal(catRes.ok, true);

  // 6. Alice submits a long Truth question
  const longTruth = 'If you could change one decision from your past without anyone ever knowing, what would it be and how would it alter your present life?';
  const submitRes = await new Promise((resolve) => {
    clientAlice.emit('task:submit', { code: roomCode, playerId: aliceId, token: aliceToken, text: longTruth, type: 'TRUTH' }, resolve);
  });
  assert.equal(submitRes.ok, true);

  // 7. Bob draws the task
  const drawRes = await new Promise((resolve) => {
    clientBob.emit('task:draw', { code: roomCode, playerId: bobId, token: bobToken }, resolve);
  });
  assert.equal(drawRes.ok, true);

  // Verify draw acknowledgement payload DOES NOT expose author
  assert.equal(drawRes.result.text, longTruth);
  assert.equal(drawRes.result.source, 'SUGGESTION');
  assert.equal(drawRes.result.authorId, undefined, 'draw callback result must not expose authorId');
  assert.equal(drawRes.result.authorName, undefined, 'draw callback result must not expose authorName');

  // Verify draw callback room payload DOES NOT expose author
  const currentTaskInBobRoom = drawRes.room.round.tasks.find(t => t.id === drawRes.room.round.currentTaskId);
  assert.equal(currentTaskInBobRoom.text, longTruth);
  assert.equal(currentTaskInBobRoom.authorId, undefined, 'room task must not expose authorId');
  assert.equal(currentTaskInBobRoom.authorName, undefined, 'room task must not expose authorName');
  assert.equal(drawRes.room.suggestions[0].authorId, undefined, 'room suggestion must not expose authorId');
  assert.equal(drawRes.room.suggestions[0].authorName, undefined, 'room suggestion must not expose authorName');

  // 8. Bob resolves task with accept
  const acceptRes = await new Promise((resolve) => {
    clientBob.emit('task:resolve', { code: roomCode, playerId: bobId, token: bobToken, action: 'accept' }, resolve);
  });
  assert.equal(acceptRes.ok, true);

  // 9. Host starts next turn
  const nextRes = await new Promise((resolve) => {
    clientAlice.emit('game:next', { code: roomCode, playerId: aliceId, token: aliceToken }, resolve);
  });
  assert.equal(nextRes.ok, true);
});
