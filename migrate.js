require('dotenv').config();
const mysql = require('mysql2/promise'); // Usaremos promises para que sea más fácil hacer await

async function migrate() {
    console.log("Iniciando migración Multi-Tenant...");
    
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        console.log("Conectado a la base de datos MySQL.");

        // 1. Crear tabla Restaurantes
        await db.execute(`
            CREATE TABLE IF NOT EXISTS restaurantes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre_negocio VARCHAR(255) NOT NULL,
                plan_suscripcion VARCHAR(50) DEFAULT 'Gratis',
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Tabla 'restaurantes' verificada/creada.");

        // 2. Insertar el restaurante por defecto (Id = 1) si no existe
        const [rows] = await db.execute("SELECT id FROM restaurantes WHERE id = 1");
        if (rows.length === 0) {
            await db.execute(`INSERT INTO restaurantes (id, nombre_negocio, plan_suscripcion) VALUES (1, 'Restaurante Principal', 'Pro')`);
            console.log("Insertado 'Restaurante Principal' (ID 1).");
        }

        // 3. Función auxiliar para agregar columnas si no existen
        async function runAlterSafely(query) {
            try {
                await db.execute(query);
                console.log(`Query ejecutada: ${query.split('ADD')[0].trim()}`);
            } catch (error) {
                if (error.code === 'ER_DUP_FIELDNAME') {
                    console.log(`La columna ya existía, saltando... (${query.substring(0, 30)}...)`);
                } else {
                    console.error("Error inesperado ejecutando query:", error.message);
                }
            }
        }

        // 4. Agregar columna restaurante_id a las tablas core
        await runAlterSafely(`ALTER TABLE usuarios ADD COLUMN restaurante_id INT DEFAULT 1`);
        await runAlterSafely(`ALTER TABLE platos ADD COLUMN restaurante_id INT DEFAULT 1`);
        await runAlterSafely(`ALTER TABLE pedidos ADD COLUMN restaurante_id INT DEFAULT 1`);
        await runAlterSafely(`ALTER TABLE gastos ADD COLUMN restaurante_id INT DEFAULT 1`);

        // 5. Normalizar datos antiguos
        await db.execute(`UPDATE usuarios SET restaurante_id = 1 WHERE restaurante_id IS NULL`);
        await db.execute(`UPDATE platos SET restaurante_id = 1 WHERE restaurante_id IS NULL`);
        await db.execute(`UPDATE pedidos SET restaurante_id = 1 WHERE restaurante_id IS NULL`);
        await db.execute(`UPDATE gastos SET restaurante_id = 1 WHERE restaurante_id IS NULL`);
        
        console.log("Tablas Core actualizadas y migración a Multi-Tenant completada con éxito.");
        
        await db.end();

    } catch (error) {
        console.error("Fallo CRÍTICO en la migración:", error);
    }
}

migrate();
