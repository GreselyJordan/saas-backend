require('dotenv').config();
const mysql = require('mysql2/promise');

async function fixEnum() {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        console.log("Alterando restricción de roles ENUM...");
        await db.query("ALTER TABLE usuarios MODIFY COLUMN rol ENUM('admin', 'mesero', 'cocinero') NOT NULL");
        console.log("¡Éxito! Ahora la base de datos permite registrar a los cocineros.");
        
        await db.end();
    } catch (e) {
        console.error(e);
    }
}
fixEnum();
