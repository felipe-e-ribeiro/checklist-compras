const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const Redis = require('ioredis');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configuração do Redis Cluster
const redisClient = new Redis.Cluster([
    {
        host: process.env.REDIS_HOST,
        port: 6379
    }
]);

redisClient.on('error', (err) => {
    console.error('Error connecting to Redis Cluster:', err);
});

redisClient.on('connect', () => {
    console.log('Connected to Redis Cluster');
});

// Configuração do adaptador do Socket.IO com Redis Cluster
(async () => {
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
})();

// Configuração da sessão HTTP com Redis Cluster
app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: 'seuSegredoAqui', // Alterar para uma chave secreta real
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // true se estiver usando HTTPS
}));

const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'lista_compras'
});

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
    const sortBy = req.query.sortBy || 'item'; // Default sort by 'item' (alphabetical)
    const sortOrder = req.query.sortOrder || 'ASC'; // Default sort order 'ASC'

    let orderByClause;
    if (sortBy === 'checked') {
        orderByClause = 'checked ASC, item ASC'; // Sort by 'checked' then 'item'
    } else {
        orderByClause = 'item ASC, checked DESC'; // Default: sort by 'item' then 'checked'
    }

    db.query(`SELECT * FROM items ORDER BY ${orderByClause}`, (err, result) => {
        if (err) throw err;
        res.render('index', { items: result, sortBy });
    });
});

app.post('/add', (req, res) => {
    const { item } = req.body;
    db.query('INSERT INTO items (item, checked) VALUES (?, false)', [item], (err, result) => {
        if (err) throw err;
        const newItem = { id: result.insertId, item, checked: false };
        io.emit('item-added', newItem);
        res.redirect('/');
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

server.listen(3000, () => {
    console.log('Server running on http://0.0.0.0:3000');
});