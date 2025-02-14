const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware para suportar x-www-form-urlencoded e JSON
app.use(bodyParser.urlencoded({ extended: true })); // Suporta formulários HTML
app.use(bodyParser.json()); // Suporta JSON

// Configuração do Redis
const redisClient = createClient({
    url: process.env.REDIS_HOST || 'redis://localhost:6379', // Use variável de ambiente para o Redis
});

redisClient.on('error', (err) => {
    console.error('Error connecting to Redis:', err);
});

redisClient.on('connect', () => {
    console.log('Connected to Redis');
});

(async () => {
    try {
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);

        io.adapter(createAdapter(pubClient, subClient));

        if (!redisClient.isOpen) {
            await redisClient.connect();
        }

        console.log('Redis clients and adapter configured successfully.');
    } catch (err) {
        console.error('Error setting up Redis clients:', err);
    }
})();

// Configuração da sessão HTTP com Redis
app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'seuSegredoAqui', // Use variável de ambiente para o segredo
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // Use "true" se estiver usando HTTPS
}));

// Configuração do MySQL
const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'lista_compras',
});

// Configuração do Socket.IO
io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Middleware e configurações do Express
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Rotas
app.get('/', (req, res) => {
    const sortBy = req.query.sortBy || 'item';
    const sortOrder = req.query.sortOrder || 'ASC';

    let orderByClause;
    if (sortBy === 'checked') {
        orderByClause = 'checked ASC, item ASC';
    } else {
        orderByClause = 'item ASC, checked DESC';
    }

    db.query(`SELECT * FROM items ORDER BY ${orderByClause}`, (err, result) => {
        if (err) throw err;
        res.render('index', { items: result, sortBy });
    });
});

app.post('/add', (req, res) => {
    const { item } = req.body;
    
    if (!item) {
        return res.status(400).json({ error: 'O campo item é obrigatório' });
    }

    db.query('INSERT INTO items (item, checked) VALUES (?, false)', [item], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Erro ao adicionar item' });
        }

        const newItem = { id: result.insertId, item, checked: false };
        io.emit('item-added', newItem);
        res.status(201).json(newItem);
    });
});

app.post('/check', (req, res) => {
    const { id, checked } = req.body;
    const isChecked = checked === 'on' ? 1 : 0;
    db.query('UPDATE items SET checked = ? WHERE id = ?', [isChecked, id], (err, result) => {
        if (err) throw err;
        const updatedItem = { id, checked: isChecked };
        io.emit('item-checked', updatedItem);
        res.redirect('/');
    });
});

app.post('/clear-checked', (req, res) => {
    db.query('DELETE FROM items WHERE checked = 1', (err, result) => {
        if (err) throw err;
        io.emit('items-cleared');
        res.redirect('/');
    });
});

// Iniciando o servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
