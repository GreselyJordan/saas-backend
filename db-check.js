require('dotenv').config();
const mysql = require('mysql2/promise');

async function checkSchema() {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        const [rows] = await db.query("DESCRIBE usuarios");
        console.log(rows);
        
        await db.end();
    } catch (e) {
        console.error(e);
    }
}
checkSchema();
