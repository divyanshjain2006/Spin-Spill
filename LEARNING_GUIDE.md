# Reading Spin & Spill

Start with `client/src/App.jsx`: it has the landing UI, socket connection, and one small component for each game phase. The server receives each action in `server/src/index.js`, identifies the player with their secret reconnect token, then calls a matching function in `server/src/services/game.js`. That service checks the current phase before changing state. It also uses Node's `crypto.randomInt`, so a browser never decides a virtual-spin or task winner.

For local development, room data lives in a JavaScript `Map`. When MongoDB is configured, the same state is also written to the `Room` Mongoose collection. This makes the setup approachable while retaining the intended MongoDB persistence path.
