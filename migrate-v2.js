require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrarFase2() {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false }
        });

        console.log("Iniciando migración V2. Añadiendo Entornos de Trabajo (Workspaces)...");

        // Agregar codigo_acceso (workspace id) y color_tema
        await db.query(`
            ALTER TABLE restaurantes 
            ADD COLUMN codigo_acceso VARCHAR(50) UNIQUE NULL,
            ADD COLUMN color_tema VARCHAR(20) DEFAULT '#1dd1a1'
        `);
        console.log("✓ Columnas añadidas a la tabla restaurantes.");

        // Asignaremos un código temporal al restaurante 1 para que no se rompa el sistema actual
        await db.query(`UPDATE restaurantes SET codigo_acceso = 'mi-hueca', nombre_negocio = 'SaaS Principal' WHERE id = 1`);
        console.log("✓ Restaurante 1 configurado con el código: 'mi-hueca'.");

        // Ahora forzamos a que el código de acceso nunca pueda estar vacío para futuros restaurantes
        await db.query(`ALTER TABLE restaurantes MODIFY COLUMN codigo_acceso VARCHAR(50) NOT NULL`);
        console.log("✓ Restricción UNIQUE y NOT NULL aplicada al código de acceso de franquicias.");

        console.log("===============================");
        console.log("✅ Migración Fas2 completada. Base de datos lista para Súper Admins.");
        
        await db.end();
    } catch (e) {
        console.error("❌ Error en la migración:", e.message);
        if (e.code === 'ER_DUP_FIELDNAME') {
            console.log("⚠️ Pareces ya haber ejecutado esto antes. Las columnas ya existen.");
        }
    }
}

migrarFase2();
