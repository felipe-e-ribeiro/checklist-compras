const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const path = require('path');
const http = require('http');
const server = http.createServer(app);

const { Server } = require("socket.io");
const io = new Server(server);

const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'lista_compras'
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Servindo arquivos estáticos da pasta public
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

app.get('/', (req, res) => {
    const sortBy = req.query.sortBy || 'item'; // Default sort by 'item' (alphabetical)
    const sortOrder = req.query.sortOrder || 'DESC'; // Default sort order 'ASC'
    
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
        console.log('Item adicionado:', [item]);
        io.emit('item-added', { id: result.insertId, item, checked: false });
        res.redirect('/');
    });
});

app.post('/check', (req, res) => {
    const { id, checked } = req.body;
    db.query('UPDATE items SET checked = ? WHERE id = ?', [checked === 'on' ? 1 : 0, id], (err, result) => {
        if (err) throw err;
        io.emit('item-checked', { id, checked: checked === 'on' ? 1 : 0 });
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