const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const db = require('./db'); // <-- Importa knex

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware para suporte a formulários e JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Configuração do Redis
const redisClient = createClient({
    url: process.env.REDIS_HOST || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

(async () => {
    try {
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);

        io.adapter(createAdapter(pubClient, subClient));

        if (!redisClient.isOpen) {
            await redisClient.connect();
        }

        console.log('Redis clients and adapter configured.');
    } catch (err) {
        console.error('Error setting up Redis clients:', err);
    }
})();

// Sessão HTTP
app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'seuSegredoAqui',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
}));

// Socket.IO
io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('disconnect', () => console.log('Client disconnected'));
});

// Express
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Rotas
app.get('/', async (req, res) => {
    const sortBy = req.query.sortBy || 'item';
    try {
        const items = await db('items')
            .where({ archived: false })
            .orderBy([
                sortBy === 'checked'
                    ? { column: 'checked', order: 'asc' }
                    : { column: 'item', order: 'asc' },
                sortBy === 'checked'
                    ? { column: 'item', order: 'asc' }
                    : { column: 'checked', order: 'desc' }
            ]);

        res.render('index', { items, sortBy });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar os itens' });
    }
});

app.post('/add', async (req, res) => {
    const { item } = req.body;

    if (!item) {
        return res.status(400).json({ error: 'O campo item é obrigatório' });
    }

    try {
        const [id] = await db('items').insert({ item, checked: false }).returning('id');
        const newItem = { id: id.id || id, item, checked: false };

        io.emit('item-added', newItem);

        if (req.accepts('html')) {
            res.redirect('/');
        } else {
            res.status(201).json(newItem);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao adicionar item' });
    }
});

app.post('/check', async (req, res) => {
    const { id, checked } = req.body;
    const isChecked = checked === 'on' ? true : false;

    try {     
        await db('items').where({ id }).update({ checked: isChecked });
        io.emit('item-checked', { id, checked: isChecked });
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar item' });
    }
});

app.post('/check-item', async (req, res) => {
    try {
        const items = await db('items').select('item');
        res.status(200).json(items);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar itens' });
    }
});

app.post('/check-archived', async (req, res) => {
    try {
        const items = await db('items')
            .select('item', 'archived_at')
            .where({ archived: true });

        res.status(200).json(items);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar itens arquivados' });
    }
});

app.post('/delete-archived', async (req, res) => {
    try {
        await db('items')
            .where({ archived: true })
            .del();

        res.status(200).json({ message: 'Itens arquivados deletados com sucesso' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao deletar itens arquivados' });
    }
});

app.delete('/remove-archived', async (req, res) => {
    try {
        const deletedCount = await db('items')
            .where({ archived: true })
            .del();

        res.status(200).json({
            message: `${deletedCount} item(ns) arquivado(s) removido(s) com sucesso.`,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao remover itens arquivados' });
    }
});


app.post('/clear-all', async (req, res) => {
    try {
        await db('items').where({ checked: true }).del();
        io.emit('items-cleared');
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao limpar itens' });
    }
});

app.post('/clear-checked', async (req, res) => {
    try {
         const fqdnUrl = process.env.FQDN_URL;
         const fqdnUser = process.env.FQDN_USER;
         const fqdnPassword = process.env.FQDN_PASSWORD;
         await axios.get(fqdnUrl, {
             auth: {
                 username: fqdnUser,
                 password: fqdnPassword
             }
         });
        await db('items')
            .where({ checked: true })
            .update({
                archived: true,
                archived_at: db.fn.now()
            });

        io.emit('item-checked');
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao arquivar os itens' });
    }
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
