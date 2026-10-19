import crypto from 'node:crypto';
import { prompts } from '../data/prompts.js';

// ─── Tiny helpers ────────────────────────────────────────────────────────────

export const id = () => crypto.randomUUID();

// Throw if the room is not in one of the allowed phases.
const requirePhase = (room, ...allowed) => {
  if (!allowed.includes(room.phase))
    throw Error(`This action is unavailable during ${room.phase}`);
};

// Throw if the player is not the host.
const requireHost = (room, p) => {
  if (room.hostId !== p.id) throw Error('Host permission required');
};

// ─── Room creation ────────────────────────────────────────────────────────────

export const createRoom = (name, token, code) => {
  const host = {
    id: id(),
    name: name.trim(),
    token,
    connected: true,
    isHost: true,
    joinedAt: Date.now(),
  };
  return {
    code,
    phase: 'LOBBY',
    players: [host],
    hostId: host.id,
    settings: {
      sourceMode: 'MIXED',   // 'MIXED' | 'BUILT_IN' | 'SUGGESTIONS'
      builtInCount: 3,        // how many built-in tasks to keep in reserve
      allowLateJoin: true,
      avoidRepeat: true,
    },
    suggestions: [],          // friend-submitted tasks for the whole room
    createdAt: Date.now(),
  };
};

// Return a sanitised view of the room (strip tokens; hide task text from target
// until it is drawn).
export function publicRoom(room, viewer) {
  return {
    ...room,
    players: room.players.map(({ token, ...p }) => p),
    suggestions: room.suggestions.map(s => ({
      ...s,
      text: viewer === room.round?.targetId ? 'Suggestion hidden until draw' : s.text,
    })),
  };
}

// Find a player by id+token, or throw.
export function getPlayer(room, playerId, token) {
  const p = room.players.find(x => x.id === playerId && x.token === token);
  if (!p) throw Error('Not authorized for this room');
  return p;
}

// ─── Game flow ────────────────────────────────────────────────────────────────

export function start(room, p) {
  requireHost(room, p);
  requirePhase(room, 'LOBBY');
  if (room.players.filter(x => x.connected).length < 2)
    throw Error('At least two connected players are needed');
  room.phase = 'PLAYER_SELECTION';
}

export function chooseTarget(room, p, targetId) {
  requireHost(room, p);
  requirePhase(room, 'PLAYER_SELECTION');
  const target = room.players.find(x => x.id === targetId && x.connected);
  if (!target) throw Error('Choose a connected player');
  if (
    room.settings.avoidRepeat &&
    target.id === room.previousTargetId &&
    room.players.filter(x => x.connected).length > 1
  ) throw Error('Choose another player this turn');
  // Start a fresh round: tasks list is empty, cycles are tracked per-type
  // inside `usedTaskIds` so each type can exhaust independently.
  room.round = {
    id: id(),
    targetId,
    taskHistory: [],   // IDs in the order they were drawn
    tasks: [],         // the full task pool for this round
    usedTaskIds: [],   // IDs of tasks that are DRAWN/SKIPPED/ACCEPTED (cannot be redrawn)
  };
  room.phase = 'CATEGORY_SELECTION';
}

export function spin(room, p) {
  requireHost(room, p);
  requirePhase(room, 'PLAYER_SELECTION');
  let eligible = room.players.filter(x => x.connected);
  if (room.settings.avoidRepeat && eligible.length > 1)
    eligible = eligible.filter(x => x.id !== room.previousTargetId);
  chooseTarget(room, p, eligible[crypto.randomInt(eligible.length)].id);
}

export function chooseCategory(room, p, type) {
  requirePhase(room, 'CATEGORY_SELECTION');
  if (room.round.targetId !== p.id) throw Error('Only the selected player can choose');
  room.round.category = type;
  room.phase = 'TASK_SUBMISSION';
}

export function submit(room, p, text, type) {
  requirePhase(room, 'TASK_SUBMISSION');
  if (p.id === room.round.targetId) throw Error('The selected player cannot submit their own task');
  text = text.trim();
  if (!text || text.length > 300) throw Error('Task must be 1–300 characters');
  if (type !== room.round.category) throw Error('Task type does not match this round');
  if (room.suggestions.some(
    s => s.authorId === p.id && s.text.toLowerCase() === text.toLowerCase() && s.status === 'AVAILABLE'
  )) throw Error('You already suggested that task');
  room.suggestions.push({
    id: id(),
    text,
    type,
    authorId: p.id,
    // Store the submitter's name so the UI can show "Submitted by Alex"
    authorName: p.name,
    status: 'AVAILABLE',
    createdAt: Date.now(),
  });
}

// ─── Task pool management ─────────────────────────────────────────────────────

/**
 * Build or refresh the task pool for the current round.
 *
 * Two-tier priority:
 *   Tier 1: Friend-submitted tasks (suggestions) for this room and category.
 *   Tier 2: Built-in prompts — only added when ALL eligible friend tasks for
 *            this category have been used/skipped in this cycle.
 *
 * A "cycle" is tracked per category inside `round.cycleExhausted`.
 * When every submitted task of a given type is used up, we set
 *   round.cycleExhausted[category] = true
 * and only then allow built-in tasks to enter the pool.
 *
 * When even the built-ins run out we reset availability so the game
 * doesn't get stuck (the user will see tasks cycle but the game continues).
 */
function buildPool(room) {
  const r = room.round;
  if (!r.cycleExhausted) r.cycleExhausted = {};
  const cat = r.category;

  // ── Tier 1: collect all friend-submitted tasks for this category that are
  //    not already in the pool (they may have been added on a previous draw).
  if (room.settings.sourceMode !== 'BUILT_IN') {
    room.suggestions
      .filter(s => s.type === cat && s.status === 'AVAILABLE')
      .forEach(s => {
        if (!r.tasks.some(t => t.id === s.id)) {
          r.tasks.push({
            id: s.id,
            text: s.text,
            type: s.type,
            source: 'SUGGESTION',
            authorId: s.authorId,
            authorName: s.authorName,
            status: 'AVAILABLE', // will be changed to DRAWN/SKIPPED/ACCEPTED
          });
        }
      });
  }

  // Check whether all friend tasks in the pool for this category are consumed.
  const friendTasks = r.tasks.filter(t => t.type === cat && t.source === 'SUGGESTION');
  const friendAvailable = friendTasks.filter(t => t.status === 'AVAILABLE');
  const allFriendDone = friendTasks.length > 0 && friendAvailable.length === 0;

  if (allFriendDone && !r.cycleExhausted[cat]) {
    // Mark that friend tasks for this category are exhausted this cycle.
    r.cycleExhausted[cat] = true;
  }

  // ── Tier 2: add built-in tasks only after friend-task cycle is exhausted
  //    (or when there were no friend tasks to begin with, or BUILT_IN mode).
  const noFriendTasks = friendTasks.length === 0;
  const shouldAddBuiltIn =
    room.settings.sourceMode !== 'SUGGESTIONS' &&
    (r.cycleExhausted[cat] || noFriendTasks);

  if (shouldAddBuiltIn) {
    // Find built-ins not yet in the pool for this category.
    const alreadyInPool = new Set(r.tasks.map(t => t.id));
    const candidates = prompts.filter(x => x.type === cat && !alreadyInPool.has(x.id));

    // Add enough built-ins to refill to builtInCount available slots.
    const builtInAvailable = r.tasks.filter(t => t.type === cat && t.source === 'BUILT_IN' && t.status === 'AVAILABLE').length;
    const needed = Math.max(2, room.settings.builtInCount) - builtInAvailable;

    let remaining = [...candidates];
    let added = 0;
    while (remaining.length && added < needed) {
      const idx = crypto.randomInt(remaining.length);
      const picked = remaining.splice(idx, 1)[0];
      r.tasks.push({ ...picked, source: 'BUILT_IN', status: 'AVAILABLE' });
      added++;
    }

    // If we still have no available tasks (every built-in was also exhausted),
    // reset the BUILT_IN statuses for this category so the game can continue.
    const stillAvailable = r.tasks.filter(t => t.type === cat && t.status === 'AVAILABLE').length;
    if (stillAvailable === 0) {
      // Documented reset: when all tasks of a type are exhausted, restart their
      // cycle so the game never gets permanently stuck.
      r.tasks
        .filter(t => t.type === cat)
        .forEach(t => { t.status = 'AVAILABLE'; });
      // Also reset the cycle flag so friend tasks can be reused next time.
      r.cycleExhausted[cat] = false;
    }
  }
}

/**
 * Draw a task for the current round.
 *
 * Priority order (same as buildPool):
 *   1. Available friend-submitted tasks of the current category
 *   2. Available built-in tasks (only once friend tasks are exhausted)
 *
 * Selection is random within the eligible set — no forced ordering.
 * The server is authoritative: all clients receive the same task via
 * the room:update broadcast.
 */
export function draw(room, p) {
  requirePhase(room, 'TASK_SUBMISSION', 'TASK_EXHAUSTED');
  if (p.id !== room.round.targetId && p.id !== room.hostId)
    throw Error('Only the target or host can draw');

  buildPool(room);

  const cat = room.round.category;
  const allAvailable = room.round.tasks.filter(t => t.type === cat && t.status === 'AVAILABLE');

  if (!allAvailable.length) {
    room.phase = 'TASK_EXHAUSTED';
    throw Error('No eligible tasks yet — add a suggestion or enable built-in prompts');
  }

  // Priority: try friend tasks first, fall back to built-in.
  const friendAvailable = allAvailable.filter(t => t.source === 'SUGGESTION');
  const pool = friendAvailable.length > 0 ? friendAvailable : allAvailable;

  const task = pool[crypto.randomInt(pool.length)];
  task.status = 'DRAWN';
  room.round.currentTaskId = task.id;
  room.round.taskHistory.push(task.id);
  room.phase = 'TASK_REVEALED';
  return task;
}

/**
 * Resolve the currently drawn task.
 *   action='accept'  → task completed; move to ROUND_COMPLETED.
 *   action='skip'    → task skipped; move to ROUND_COMPLETED.
 *   action='redraw'  → task skipped; immediately draw another one.
 *
 * Skipped tasks have status='SKIPPED', which means buildPool will never
 * include them again (they are no longer 'AVAILABLE').
 */
export function resolve(room, p, action) {
  requirePhase(room, 'TASK_REVEALED');
  if (p.id !== room.round.targetId) throw Error('Only the selected player can do that');
  const task = room.round.tasks.find(t => t.id === room.round.currentTaskId);
  if (action === 'accept') {
    task.status = 'ACCEPTED';
    room.phase = 'ROUND_COMPLETED';
    return;
  }
  // Both 'skip' and 'redraw' mark the task as SKIPPED so it won't be re-drawn.
  task.status = 'SKIPPED';
  if (action === 'skip') {
    room.phase = 'ROUND_COMPLETED';
    return;
  }
  // 'redraw': go back to submission phase so draw() can be called again.
  room.phase = 'TASK_SUBMISSION';
  return draw(room, p);
}

/**
 * End the current round and reset for the next one.
 * Suggestions are cleared so they don't carry over across rounds.
 */
export function next(room, p) {
  requireHost(room, p);
  requirePhase(room, 'ROUND_COMPLETED');
  room.previousTargetId = room.round.targetId;
  room.round = undefined;
  room.suggestions = []; // Fresh slate: each round has its own suggestion pool
  room.phase = 'PLAYER_SELECTION';
}
