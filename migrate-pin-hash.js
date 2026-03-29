/**
 * Script de migración: Hashear todos los PINs existentes
 *
 * EJECUTAR SOLO UNA VEZ después de actualizar el backend con bcrypt.
 *
 * Uso: node migrate-pin-hash.js
 */

require('dotenv').config();
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: { rejectUnauthorized: false }
});

const query = (sql, params) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, result) => {
    if (err) reject(err);
    else resolve(result);
  });
});

async function migrarPines() {
  console.log('🔒 Iniciando migración de PINs a bcrypt...\n');

  try {
    // 1. Obtener todos los usuarios con sus PINs actuales
    const usuarios = await query('SELECT id, nombre, pin FROM usuarios');
    console.log(`📋 Se encontraron ${usuarios.length} usuarios.\n`);

    if (usuarios.length === 0) {
      console.log('✅ No hay usuarios para migrar.');
      process.exit(0);
    }

    // 2. Hashear cada PIN y actualizar
    let actualizados = 0;
    let errores = 0;

    for (const usuario of usuarios) {
      try {
        // Verificar si ya está hasheado (los hashes de bcrypt empiezan con $2b$ o $2a$)
        if (usuario.pin.startsWith('$2b$') || usuario.pin.startsWith('$2a$')) {
          console.log(`⏭️  Usuario ${usuario.nombre} (ID: ${usuario.id}) ya tiene PIN hasheado. Saltando...`);
          continue;
        }

        const pinHasheado = await bcrypt.hash(usuario.pin, 10);
        await query('UPDATE usuarios SET pin = ? WHERE id = ?', [pinHasheado, usuario.id]);
        console.log(`✅ Usuario ${usuario.nombre} (ID: ${usuario.id}) actualizado.`);
        actualizados++;
      } catch (err) {
        console.error(`❌ Error actualizando usuario ${usuario.nombre} (ID: ${usuario.id}):`, err.message);
        errores++;
      }
    }

    console.log('\n========================================');
    console.log('📊 RESUMEN DE MIGRACIÓN');
    console.log('========================================');
    console.log(`✅ Actualizados: ${actualizados}`);
    console.log(`⏭️  Ya hasheados: ${usuarios.length - actualizados - errores}`);
    console.log(`❌ Errores: ${errores}`);
    console.log('========================================');

    if (errores === 0) {
      console.log('\n🎉 ¡Migración completada exitosamente!');
    } else {
      console.log('\n⚠️  Migración completada con errores. Revisa los mensajes arriba.');
    }

  } catch (err) {
    console.error('❌ Error general en la migración:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

migrarPines();