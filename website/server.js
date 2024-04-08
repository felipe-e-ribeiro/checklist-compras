const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const path = require('path');

const app = express();

const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'lista_compras'
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.get('/', (req, res) => {
    db.query('SELECT * FROM items ORDER by checked', (err, result) => {
        if (err) throw err;
        res.render('index', { items: result });
    });
});

app.post('/add', (req, res) => {
    const { item } = req.body;
    db.query('INSERT INTO items (item, checked) VALUES (?, false)', [item], (err, result) => {
        if (err) throw err;
        res.redirect('/');
    });
});

app.post('/check', (req, res) => {
    const { id, checked } = req.body;
    db.query('UPDATE items SET checked = ? WHERE id = ?', [checked === 'on' ? 1 : 0, id], (err, result) => {
        if (err) throw err;
        res.redirect('/');
    });
});

app.post('/clear-checked', (req, res) => {
    db.query('DELETE FROM items WHERE checked = 1', (err, result) => {
        if (err) throw err;
        res.redirect('/');
    });
});

app.listen(3000, () => {
    console.log('Server running on http://0.0.0.0:3000');
});