require('dotenv').config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const express = require('express');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

const morgan = require('morgan');
const { makeRequireAuth, makeRequireTenant } = require('./middleware/auth');
const makeAuthRouter = require('./routes/auth');
const makeAccessRouter = require('./routes/access');
const makeWorkspaceRouter = require('./routes/workspace');
const makeItemsRouter = require('./routes/items');
const authService = require('./services/authService');

function createApp(db) {
  const app = express();

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(':method :url :status :response-time ms'));
  }

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails[0].value;
          const googleId = profile.id;
          const name = profile.displayName;
          const avatarUrl = profile.photos && profile.photos[0] && profile.photos[0].value;

          let user = await db('users').where({ google_id: googleId }).first();
          if (!user) {
            [user] = await db('users')
              .insert({ google_id: googleId, email, name, avatar_url: avatarUrl })
              .returning('*');
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  app.use(passport.initialize());

  const requireAuth = makeRequireAuth(db);
  const requireTenant = makeRequireTenant(db);

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/select-workspace'));

  return { app, requireAuth, requireTenant };
}

// Configurar Redis adapter ANTES de aceitar conexões Socket.IO.
// setupRedisAdapter é awaited em createServer para garantir que todos os
// workers têm o Redis adapter ativo antes de qualquer socket conectar.
// Sem isso, sockets que entram antes do adapter estar pronto ficam no
// adapter in-memory local e não recebem eventos cross-worker.
async function setupRedisAdapter(io) {
  const pubClient = createClient({ url: process.env.REDIS_HOST || 'redis://localhost:6379' });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('Redis pub error:', err.message));
  subClient.on('error', (err) => console.error('Redis sub error:', err.message));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log(`Worker ${process.pid} Redis adapter pronto`);
}

async function createServer(db) {
  const { app, requireAuth, requireTenant } = createApp(db);
  const server = http.createServer(app);
  const io = new Server(server);

  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.request.headers.cookie || '';
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const [k, ...v] = c.trim().split('=');
          return [k.trim(), v.join('=')];
        })
      );
      const token = cookies.access_token;
      if (!token) return next(new Error('UNAUTHORIZED'));
      const payload = authService.verifyAccessToken(token);
      socket.tenantId = payload.tenantId;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.tenantId) socket.join(socket.tenantId);
  });

  // Aguardar Redis ANTES de registrar rotas e retornar o servidor.
  // Garante que qualquer socket que conectar já usa o adapter correto.
  await setupRedisAdapter(io);

  app.use(makeAuthRouter(db));
  app.use(makeAccessRouter(db));
  app.use(makeWorkspaceRouter(db, requireAuth, requireTenant));
  app.use(makeItemsRouter(db, requireAuth, requireTenant, io));

  return server;
}

function createTestApp(db) {
  const { app, requireAuth, requireTenant } = createApp(db);
  const io = { to: () => ({ emit: () => {} }) };
  app.use(makeAuthRouter(db));
  app.use(makeAccessRouter(db));
  app.use(makeWorkspaceRouter(db, requireAuth, requireTenant));
  app.use(makeItemsRouter(db, requireAuth, requireTenant, io));
  return app;
}

if (require.main === module) {
  const cluster = require('cluster');
  const WORKERS = parseInt(process.env.WEB_CONCURRENCY) || 2;

  if (cluster.isPrimary && WORKERS > 1) {
    console.log(`Primary ${process.pid} iniciando ${WORKERS} workers...`);
    for (let i = 0; i < WORKERS; i++) cluster.fork();
    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.process.pid} encerrou (${signal || code}) — reiniciando...`);
      cluster.fork();
    });
  } else {
    const db = require('./db');
    const PORT = process.env.PORT || 3000;
    createServer(db)
      .then((server) => {
        server.listen(PORT, () =>
          console.log(`Worker ${process.pid} em http://0.0.0.0:${PORT}`)
        );
      })
      .catch((err) => {
        console.error(`Worker ${process.pid} falhou ao iniciar:`, err.message);
        process.exit(1);
      });
  }
}

module.exports = { createApp: createTestApp };
