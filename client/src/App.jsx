/**
 * App.jsx — Spin & Spill frontend
 *
 * How it works (beginner-friendly summary):
 * ─────────────────────────────────────────
 * 1. The app connects to the backend via Socket.IO on mount.
 *    In development, Vite proxies /socket.io/* to port 3001 so the browser
 *    never makes a cross-origin request (no CORS issues in Codespaces).
 *
 * 2. The backend is authoritative for ALL game state.
 *    The frontend only REQUESTS actions (e.g. "draw a task") and renders
 *    whatever state the server broadcasts in the 'room:update' event.
 *
 * 3. Task selection priority (enforced on the server):
 *    • First: tasks submitted by players in this room (friend tasks)
 *    • Second: built-in prompts (only used when friend tasks are exhausted)
 *
 * 4. Skipped tasks are marked on the server so they cannot be re-drawn
 *    during the same cycle.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Wine, Copy, Users, RefreshCw, SkipForward,
  Play, Check, AlertCircle, Sparkles, Heart,
} from 'lucide-react';
import { io } from 'socket.io-client';

// ─── Socket connection ───────────────────────────────────────────────────────
// In development: VITE_SERVER_URL is unset → io() connects to window.location.origin
//   (Vite port 5173), which proxies to backend port 3001 via vite.config.js.
// In production: set VITE_SERVER_URL=https://your-backend.railway.app
const endpoint = import.meta.env.VITE_SERVER_URL || undefined;

// ─── Local storage helpers ───────────────────────────────────────────────────
const savedIdentity = () =>
  JSON.parse(localStorage.getItem('spin-spill-player') || 'null');

const storeIdentity = (who) =>
  localStorage.setItem('spin-spill-player', JSON.stringify(who));

// ─── Client-side name validation ─────────────────────────────────────────────
// Mirrors the server's cleanName rules so the user gets instant feedback.
const validateName = (name) => {
  if (!name || !name.trim()) return 'Please enter a display name.';
  if (name.trim().length > 24) return 'Display name must be 24 characters or fewer.';
  return null;
};

// ─── Tiny reusable Button ────────────────────────────────────────────────────
function Button({ children, kind = '', loading = false, ...props }) {
  return (
    <button
      className={`button ${kind} ${loading ? 'loading' : ''}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <RefreshCw size={16} className="spin-icon" /> : children}
    </button>
  );
}

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const socket   = useRef(null);
  const [room,     setRoom]     = useState(null);
  const [identity, setIdentity] = useState(savedIdentity);
  const [name,     setName]     = useState('');
  const [code,     setCode]     = useState(
    new URLSearchParams(location.search).get('room') || ''
  );
  const [notice,   setNotice]   = useState('');
  const [busy,     setBusy]     = useState(false); // prevents double-clicks

  // Connect to Socket.IO on mount; disconnect on unmount.
  useEffect(() => {
    socket.current = endpoint ? io(endpoint) : io();
    socket.current.on('room:update', setRoom);
    return () => socket.current.disconnect();
  }, []);

  // ── Generic socket call helper ──────────────────────────────────────────────
  // Emits an event, waits for the server acknowledgement, updates state.
  // Returns a Promise that resolves with the server reply.
  const call = useCallback((event, data = {}) => {
    return new Promise((resolve) => {
      socket.current.emit(
        event,
        { ...data, code: room?.code, ...identity },
        (reply) => {
          if (!reply.ok) {
            setNotice(reply.error);
          } else {
            setNotice('');
            if (reply.room) setRoom(reply.room);
            resolve(reply);
          }
        }
      );
    });
  }, [room, identity]);

  // ── Async action wrapper with busy state ────────────────────────────────────
  // Prevents two simultaneous button presses from sending duplicate requests.
  const act = useCallback(async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); }
    finally { setBusy(false); }
  }, [busy]);

  // ── Save identity + room after create/join ──────────────────────────────────
  const saveSession = (reply) => {
    const who = { playerId: reply.playerId, token: reply.token };
    storeIdentity(who);
    setIdentity(who);
    setRoom(reply.room);
    history.replaceState({}, '', `?room=${reply.code}`);
  };

  // ── Create / Join handlers ──────────────────────────────────────────────────
  const handleCreate = () => {
    const err = validateName(name);
    if (err) return setNotice(err);
    act(() => new Promise((resolve) => {
      socket.current.emit('room:create', { name: name.trim() }, (reply) => {
        if (!reply.ok) setNotice(reply.error);
        else { setNotice(''); saveSession(reply); }
        resolve();
      });
    }));
  };

  const handleJoin = () => {
    const err = validateName(name);
    if (err) return setNotice(err);
    if (!code.trim()) return setNotice('Please enter a room code.');
    act(() => new Promise((resolve) => {
      socket.current.emit('room:join', { code: code.trim(), name: name.trim(), ...(identity || {}) }, (reply) => {
        if (!reply.ok) setNotice(reply.error);
        else { setNotice(''); saveSession(reply); }
        resolve();
      });
    }));
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!room) {
    return <Landing
      name={name}
      setName={(v) => { setName(v); setNotice(''); }}
      code={code}
      setCode={(v) => setCode(v.toUpperCase())}
      notice={notice}
      onCreate={handleCreate}
      onJoin={handleJoin}
      busy={busy}
    />;
  }

  const me     = room.players.find(p => p.id === identity?.playerId);
  const target = room.players.find(p => p.id === room.round?.targetId);
  const isHost = me?.id === room.hostId;

  return (
    <div className="game-wrap">
      <header className="game-header">
        <div className="brand"><Wine size={18} /> SPIN <i>&amp;</i> SPILL</div>
        <div className="room-badge">
          <span className="dot" /> ROOM {room.code}
        </div>
      </header>

      {notice && (
        <div className="toast" role="alert" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}

      <div className="game-grid">
        {/* ── Players panel ── */}
        <aside className="players-panel card">
          <h3>
            <Users size={15} /> Players
            <span className="count">{room.players.length}</span>
          </h3>
          <div className="player-list">
            {room.players.map(p => (
              <div className="player-row" key={p.id}>
                <div className="player-avatar">{p.name[0].toUpperCase()}</div>
                <span className="player-name">
                  {p.name}
                  {p.isHost && <span className="player-tag"> · Host</span>}
                </span>
                <span className={`status-dot ${p.connected ? 'online' : 'offline'}`}
                      title={p.connected ? 'Online' : 'Offline'} />
              </div>
            ))}
          </div>
          <div className="share-section">
            <Button
              kind="ghost full"
              onClick={() => navigator.clipboard.writeText(location.href)}
            >
              <Copy size={14} /> Copy invite link
            </Button>
            <QRCodeSVG value={location.href} size={88} bgColor="transparent" fgColor="#faf7ff" />
          </div>
        </aside>

        {/* ── Game stage ── */}
        <main className="stage">
          <Phase
            room={room}
            me={me}
            target={target}
            isHost={isHost}
            call={call}
            act={act}
            busy={busy}
          />
        </main>
      </div>
    </div>
  );
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function Landing({ name, setName, code, setCode, notice, onCreate, onJoin, busy }) {
  return (
    <div className="landing">
      <div className="orb one" aria-hidden="true" />
      <div className="orb two" aria-hidden="true" />
      <section className="hero">
        <div className="brand"><Wine size={22} /> SPIN <i>&amp;</i> SPILL</div>
        <p className="eyebrow">Real-time Truth or Dare</p>
        <h1>Gather your people.<br />Let chaos begin.</h1>
        <p className="lead">
          Spin a bottle, spill a secret, dare your friends.
          One room — every screen in sync.
        </p>

        <div className="card landing-form">
          <label className="form-label" htmlFor="display-name">Your display name</label>
          <input
            id="display-name"
            className="input"
            value={name}
            maxLength={24}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onCreate()}
            placeholder="What should we call you?"
            autoComplete="nickname"
            inputMode="text"
          />
          <div className="form-actions">
            <Button kind="full" onClick={onCreate} loading={busy}>
              <Play size={15} /> Create a room
            </Button>
          </div>

          <div className="divider">or join the party</div>

          <label className="form-label" htmlFor="room-code">Room code</label>
          <div className="input-row">
            <input
              id="room-code"
              className="input"
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onJoin()}
              placeholder="ABCXYZ"
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              maxLength={6}
            />
            <Button kind="secondary" onClick={onJoin} loading={busy}>
              Join
            </Button>
          </div>

          {notice && (
            <div className="error-msg" role="alert">
              <AlertCircle size={14} style={{ flexShrink: 0 }} /> {notice}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Game Phase router ────────────────────────────────────────────────────────
function Phase({ room, me, target, isHost, call, act, busy }) {
  const phase = room.phase;

  if (phase === 'LOBBY') {
    return (
      <PhaseCard eyebrow="Lobby" title="The lobby is yours"
        sub="Invite at least one friend, then start the magic.">
        <div className="room-code" aria-label={`Room code: ${room.code}`}>{room.code}</div>
        {isHost
          ? <Button kind="full" onClick={() => act(() => call('game:start'))} loading={busy}>
              <Play size={16} /> Start game
            </Button>
          : <p className="muted">Waiting for the host to start…</p>
        }
      </PhaseCard>
    );
  }

  if (phase === 'PLAYER_SELECTION') {
    return (
      <PhaseCard eyebrow="Spin the bottle" title="Who gets chosen?"
        sub="Spin virtually, or tap a player.">
        <div className="bottle-wrap"><Wine size={96} /></div>
        {isHost ? (
          <>
            <Button kind="full" onClick={() => act(() => call('game:spin'))} loading={busy}>
              <RefreshCw size={15} /> Virtual spin
            </Button>
            <p className="or-divider">— or choose someone —</p>
            <div className="target-grid">
              {room.players.filter(p => p.connected).map(p => (
                <Button
                  key={p.id}
                  kind="secondary"
                  onClick={() => act(() => call('game:target', { targetId: p.id }))}
                  loading={busy}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">The host is spinning the bottle…</p>
        )}
      </PhaseCard>
    );
  }

  if (phase === 'CATEGORY_SELECTION') {
    const isTarget = me?.id === target?.id;
    return (
      <PhaseCard eyebrow="You've been chosen!" title={`${target?.name ?? '...'} is up!`}
        sub={isTarget ? 'What will it be?' : "They're choosing their fate…"}>
        <div className="reveal-name">{target?.name}</div>
        {isTarget && (
          <div className="choice-row">
            <Button kind="truth choice-btn" onClick={() => act(() => call('game:category', { type: 'TRUTH' }))} loading={busy}>
              TRUTH
              <small>Tell it like it is</small>
            </Button>
            <Button kind="dare choice-btn" onClick={() => act(() => call('game:category', { type: 'DARE' }))} loading={busy}>
              DARE
              <small>Do something bold</small>
            </Button>
          </div>
        )}
      </PhaseCard>
    );
  }

  if (phase === 'TASK_SUBMISSION' || phase === 'TASK_EXHAUSTED') {
    return <SubmissionPhase room={room} me={me} target={target} isHost={isHost} call={call} act={act} busy={busy} />;
  }

  if (phase === 'TASK_REVEALED') {
    return <RevealPhase room={room} me={me} target={target} call={call} act={act} busy={busy} />;
  }

  // ROUND_COMPLETED
  return (
    <PhaseCard eyebrow="Round over" title="Round complete!"
      sub={`${target?.name ?? 'Someone'} survived another one.`}>
      {isHost
        ? <Button kind="full" onClick={() => act(() => call('game:next'))} loading={busy}>
            Next turn <RefreshCw size={15} />
          </Button>
        : <p className="muted">Waiting for the host to continue…</p>
      }
    </PhaseCard>
  );
}

// ─── Submission phase ─────────────────────────────────────────────────────────
function SubmissionPhase({ room, me, target, isHost, call, act, busy }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const category = room.round?.category;
  const isTarget = me?.id === target?.id;
  const sourceMode = room.settings.sourceMode;
  // Count suggestions already in the pot for this category
  const suggestionCount = room.suggestions.filter(s => s.type === category).length;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    act(async () => {
      await call('task:submit', { text: text.trim(), type: category });
      setText('');
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    });
  };

  return (
    <PhaseCard
      eyebrow={category}
      title={`${target?.name ?? '...'} chose ${category}`}
      sub={isTarget
        ? 'Your friends are cooking something up…'
        : 'Write a fun, kind prompt. The target won\'t see it until draw time.'
      }
    >
      <span className={`category-tag ${category}`}>{category}</span>

      {/* Non-target players can submit suggestions */}
      {!isTarget && sourceMode !== 'BUILT_IN' && (
        <form className="suggest-form" onSubmit={handleSubmit}>
          <textarea
            className="input"
            value={text}
            onChange={e => setText(e.target.value)}
            maxLength={300}
            placeholder={`Write a ${category?.toLowerCase()}…`}
            aria-label="Submit a suggestion"
          />
          <Button kind="full" loading={busy} disabled={!text.trim()}>
            {sent ? <><Check size={14} /> Sent!</> : 'Send suggestion'}
          </Button>
        </form>
      )}

      <p className="suggestion-count">
        {suggestionCount === 0
          ? 'No suggestions yet — be the first!'
          : `${suggestionCount} suggestion${suggestionCount === 1 ? '' : 's'} in the pot`
        }
      </p>

      {/* Target or host can draw */}
      {(isTarget || isHost) && (
        <Button kind="full" onClick={() => act(() => call('task:draw'))} loading={busy}>
          <Sparkles size={15} /> Draw a task
        </Button>
      )}
    </PhaseCard>
  );
}

// ─── Task reveal phase ────────────────────────────────────────────────────────
function RevealPhase({ room, me, target, call, act, busy }) {
  const task = room.round?.tasks?.find(t => t.id === room.round.currentTaskId);
  const isTarget = me?.id === target?.id;

  // Count remaining friend tasks for the current category so we can show
  // the fallback notice when they run out.
  const cat = room.round?.category;
  const friendTasksLeft = room.round?.tasks?.filter(
    t => t.source === 'SUGGESTION' && t.status === 'AVAILABLE' && t.type === cat
  ).length ?? 0;

  const isFriendTask = task?.source === 'SUGGESTION';

  return (
    <PhaseCard
      eyebrow="Task revealed"
      title="The spill is in…"
      sub={`For ${target?.name ?? '...'}`}
    >
      {task && (
        <div className="task-card">
          {/* Source badge */}
          <div className={`task-source-badge ${isFriendTask ? 'friend' : 'builtin'}`}>
            {isFriendTask
              ? <><Heart size={10} /> From a friend</>
              : <><Sparkles size={10} /> House prompt</>
            }
          </div>

          {/* Task text */}
          <div className="task-text">{task.text}</div>

          {/* Submitter attribution */}
          {isFriendTask && task.authorName && (
            <div className="task-author">Submitted by {task.authorName}</div>
          )}
        </div>
      )}

      {/* Show notice when we've just fallen back to built-in tasks */}
      {!isFriendTask && friendTasksLeft === 0 && (
        <div className="fallback-notice">
          <Sparkles size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          Your friends' {cat?.toLowerCase()}s are all used up — this is a built-in prompt.
        </div>
      )}

      {/* Action buttons (only target can act) */}
      {isTarget && (
        <div className="task-actions">
          <Button
            kind=""
            onClick={() => act(() => call('task:resolve', { action: 'accept' }))}
            loading={busy}
          >
            <Check size={15} /> Complete task
          </Button>
          <Button
            kind="secondary"
            onClick={() => act(() => call('task:resolve', { action: 'redraw' }))}
            loading={busy}
          >
            <RefreshCw size={15} /> Give me another
          </Button>
          <Button
            kind="ghost"
            onClick={() => act(() => call('task:resolve', { action: 'skip' }))}
            loading={busy}
          >
            <SkipForward size={15} /> Skip
          </Button>
        </div>
      )}

      {!isTarget && (
        <p className="muted" style={{ marginTop: 12 }}>
          Waiting for {target?.name} to decide…
        </p>
      )}
    </PhaseCard>
  );
}

// ─── Reusable phase card wrapper ──────────────────────────────────────────────
function PhaseCard({ eyebrow, title, sub, children }) {
  return (
    <div className="phase-card card">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {sub && <p className="sub">{sub}</p>}
      {children}
    </div>
  );
}
