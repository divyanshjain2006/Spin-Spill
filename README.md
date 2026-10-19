# Spin & Spill

Real-time Truth or Dare built with React, Express, Socket.IO, MongoDB/Mongoose, and plain JavaScript. It is deliberately organized with small, readable modules for learning.

## Run it

1. Copy `.env.example` to `.env`. MongoDB is optional during local UI development: without it, the server uses in-memory room data for the running session.
2. Run `npm install` and then `npm run dev`.
3. Visit `http://localhost:5173` in two browsers, create a room, and join with its code.

The authoritative gameplay rules are in `server/src/services/game.js`; socket events are in `server/src/index.js`; local prompt data is in `server/src/data/prompts.js`.

## Library choices

- Socket.IO synchronizes room state over websockets.
- Mongoose persists room state when `MONGODB_URI` is available.
- qrcode.react draws the share QR code.
- Everything else uses React, CSS, and ordinary JavaScript.
