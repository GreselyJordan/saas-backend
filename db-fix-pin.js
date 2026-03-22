require('dotenv').config();
const mysql = require('mysql2/promise');

async function fixPin() {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        console.log("Borrando la restricción UNIQUE global del PIN...");
        // Primero necesitamos saber exactamente cómo se llama el índice.
        // En MySQL, si la columna se llama 'pin', normalmente el índice UNIQUE por defecto se llama 'pin'.
        await db.query("ALTER TABLE usuarios DROP INDEX pin");
        
        console.log("¡Éxito! Ahora los PINs pueden repetirse entre diferentes restaurantes.");
        
        await db.end();
    } catch (e) {
        console.error("Error al borrar índice:", e.message);
        if (e.message.includes("check that column/key exists")) {
             console.log("El índice no se llama 'pin' o ya fue borrado.");
        }
    }
}
fixPin();
