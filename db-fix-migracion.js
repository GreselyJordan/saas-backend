require('dotenv').config();
const mysql = require('mysql2/promise');

async function fixMigracion() {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        // 1. Asignar código temporal al restaurante 1
        console.log("Asignando código 'mi-hueca' al rest 1...");
        await db.query(`UPDATE restaurantes SET codigo_acceso = 'mi-hueca', nombre_negocio = 'SaaS Principal' WHERE id = 1 AND codigo_acceso IS NULL`);
        console.log("✓ OK");

        // 2. Modificar la columna para que sea NOT NULL
        console.log("Aplicando NOT NULL a codigo_acceso...");
        await db.query(`ALTER TABLE restaurantes MODIFY COLUMN codigo_acceso VARCHAR(50) NOT NULL`);
        console.log("✓ OK");
        
        await db.end();
    } catch (e) {
        console.error("❌ Error en la corrección:", e);
    }
}
fixMigracion();
