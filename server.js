require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const winston = require('winston');

// ==========================================
// LOGGER — winston estructurado
// ==========================================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
});

// ==========================================
// VALIDACIÓN DE VARIABLES DE ENTORNO CRÍTICAS
// ==========================================
const requiredEnvVars = ['JWT_SECRET', 'SUPER_ADMIN_KEY', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Variable de entorno faltante: ${envVar}. El servidor no puede arrancar.`);
    process.exit(1);
  }
}

const SECRET_KEY = process.env.JWT_SECRET;
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY;

// ==========================================
// CONFIGURACIÓN DE LA APLICACIÓN
// ==========================================
const app = express();
const server = http.createServer(app);

// ==========================================
// CORS — orígenes permitidos desde .env
// ==========================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (Postman, mobile) y orígenes en la lista
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS bloqueado para origen: ${origin}`);
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
}));

// ==========================================
// SOCKET.IO — configurado con CORS y rooms
// ==========================================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// Cada restaurante se une a su propio room para aislar eventos
io.on('connection', (socket) => {
  const restauranteId = socket.handshake.query.restaurante_id;
  if (restauranteId) {
    socket.join(`restaurante_${restauranteId}`);
    logger.info(`Socket conectado al room: restaurante_${restauranteId}`);
  }

  socket.on('disconnect', () => {
    logger.info(`Socket desconectado del room: restaurante_${restauranteId}`);
  });
});

app.use(express.json());

// ==========================================
// CONEXIÓN A MYSQL — Pool con reconexión
// ==========================================
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

// Verificar conexión al iniciar
db.getConnection((err, connection) => {
  if (err) {
    logger.error(`Error conectando a MySQL: ${err.message}`);
    return;
  }
  logger.info('¡Conectado al pool de MySQL con éxito!');
  connection.release();
});

// Helper para promisificar queries del pool
const query = (sql, params) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, result) => {
    if (err) reject(err);
    else resolve(result);
  });
});

// ==========================================
// SCHEMAS DE VALIDACIÓN — zod
// ==========================================
const schemas = {
  login: z.object({
    pin: z.string().min(1, 'El PIN es requerido').max(10),
    codigo_restaurante: z.string().min(1, 'El código de restaurante es requerido')
  }),
  crearPlato: z.object({
    nombre: z.string().min(1, 'El nombre es requerido').max(100),
    descripcion: z.string().max(255).optional(),
    precio: z.number({ invalid_type_error: 'El precio debe ser un número' }).positive('El precio debe ser positivo'),
    categoria: z.string().min(1, 'La categoría es requerida')
  }),
  crearUsuario: z.object({
    nombre: z.string().min(1, 'El nombre es requerido').max(80),
    pin: z.string().min(4, 'El PIN debe tener mínimo 4 caracteres').max(8),
    rol: z.enum(['admin', 'mesero', 'cajero'], { errorMap: () => ({ message: 'Rol inválido' }) })
  }),
  pedidoPublico: z.object({
    mesa: z.string().min(1, 'La mesa es requerida'),
    total: z.number({ invalid_type_error: 'El total debe ser un número' }).nonnegative(),
    restaurante_id: z.coerce.number({ invalid_type_error: 'El ID del restaurante es inválido' }).int().positive(),
    items: z.array(z.object({
      nombre: z.string(),
      cantidad: z.number().int().positive(),
      subtotal: z.number().nonnegative()
    })).optional()
  }),
  crearRestaurante: z.object({
    nombre_negocio: z.string().min(1).max(100),
    codigo_acceso: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/, 'Solo letras minúsculas, números y guiones'),
    clave_secreta: z.string()
  })
};

// Middleware de validación reutilizable
const validar = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const mensajes = result.error.errors.map(e => e.message).join(', ');
    return res.status(400).json({ error: mensajes });
  }
  req.body = result.data; // datos limpios y tipados
  next();
};

// ==========================================
// RATE LIMITING — protección de login
// ==========================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // máximo 10 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Intenta de nuevo en 15 minutos.' }
});

// ==========================================
// MIDDLEWARE DE SEGURIDAD (JWT)
// ==========================================
const verificarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ error: 'Acceso denegado: Token requerido.' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.usuario = decoded; // { id, rol, restaurante_id }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
};

// Middleware de SuperAdmin
const verificarSuperAdmin = (req, res, next) => {
  const llave = req.headers['x-super-admin-key'] || req.body?.clave_secreta;
  if (llave !== SUPER_ADMIN_KEY) {
    logger.warn(`Intento de acceso SuperAdmin fallido desde: ${req.ip}`);
    return res.status(403).json({ error: 'Acceso denegado. Llave de Súper Administrador inválida.' });
  }
  next();
};

// ==========================================
// RUTAS DE SEGURIDAD: LOGIN
// ==========================================
app.post('/api/login', loginLimiter, validar(schemas.login), async (req, res, next) => {
  const { pin, codigo_restaurante } = req.body;

  try {
    const resRestaurantes = await query(
      'SELECT id FROM restaurantes WHERE codigo_acceso = ?',
      [codigo_restaurante]
    );

    if (resRestaurantes.length === 0) {
      return res.status(404).json({ error: 'Este código de restaurante no existe.' });
    }

    const idDelRestaurante = resRestaurantes[0].id;

    const results = await query(
      `SELECT u.id, u.nombre, u.rol, u.restaurante_id, r.nombre_negocio, r.color_tema 
       FROM usuarios u 
       JOIN restaurantes r ON u.restaurante_id = r.id 
       WHERE u.pin = ? AND u.estado = true AND u.restaurante_id = ?`,
      [pin, idDelRestaurante]
    );

    if (results.length > 0) {
      const usuarioEncontrado = results[0];
      const token = jwt.sign(
        {
          id: usuarioEncontrado.id,
          rol: usuarioEncontrado.rol,
          restaurante_id: usuarioEncontrado.restaurante_id,
          nombre_negocio: usuarioEncontrado.nombre_negocio,
          color_tema: usuarioEncontrado.color_tema
        },
        SECRET_KEY,
        { expiresIn: '12h' }
      );

      logger.info(`Login exitoso: ${usuarioEncontrado.nombre} (Restaurante ID: ${idDelRestaurante})`);
      res.json({ exito: true, mensaje: `¡Bienvenido, ${usuarioEncontrado.nombre}!`, usuario: usuarioEncontrado, token });
    } else {
      logger.warn(`Login fallido: PIN incorrecto para restaurante ${idDelRestaurante} desde IP ${req.ip}`);
      res.status(401).json({ exito: false, error: 'PIN incorrecto para este restaurante.' });
    }
  } catch (err) {
    next(err);
  }
});

// ==========================================
// MODO DIOS: SÚPER ADMIN (CREAR FRANQUICIAS)
// ==========================================
app.post('/api/superadmin/restaurantes', verificarSuperAdmin, validar(schemas.crearRestaurante), async (req, res, next) => {
  const { nombre_negocio, codigo_acceso } = req.body;

  // Obtener una conexión del pool para usar transacción
  db.getConnection(async (connErr, connection) => {
    if (connErr) return next(connErr);

    try {
      await new Promise((resolve, reject) => connection.beginTransaction(err => err ? reject(err) : resolve()));

      const [result] = await new Promise((resolve, reject) => {
        connection.query(
          'INSERT INTO restaurantes (nombre_negocio, codigo_acceso) VALUES (?, ?)',
          [nombre_negocio, codigo_acceso],
          (err, r) => err ? reject(err) : resolve([r])
        );
      });

      const nuevoRestauranteId = result.insertId;
      const pinInicial = '1234';

      await new Promise((resolve, reject) => {
        connection.query(
          "INSERT INTO usuarios (nombre, pin, rol, restaurante_id, estado) VALUES (?, ?, 'admin', ?, true)",
          ['Dueño ' + nombre_negocio, pinInicial, nuevoRestauranteId],
          (err) => err ? reject(err) : resolve()
        );
      });

      await new Promise((resolve, reject) => connection.commit(err => err ? reject(err) : resolve()));
      connection.release();

      logger.info(`Nueva franquicia creada: ${nombre_negocio} (código: ${codigo_acceso})`);
      res.status(201).json({
        exito: true,
        mensaje: `¡Franquicia ${nombre_negocio} creada con éxito!`,
        datos: { codigo_acceso, pin_inicial: pinInicial }
      });
    } catch (err) {
      connection.rollback(() => connection.release());
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Ese código de acceso ya está en uso por otro restaurante.' });
      }
      next(err);
    }
  });
});

app.get('/api/superadmin/restaurantes', verificarSuperAdmin, async (req, res, next) => {
  try {
    const results = await query(`
      SELECT r.id, r.nombre_negocio, r.codigo_acceso,
             (SELECT COUNT(*) FROM usuarios u WHERE u.restaurante_id = r.id) as total_empleados,
             (SELECT COUNT(*) FROM pedidos p WHERE p.restaurante_id = r.id) as total_pedidos
      FROM restaurantes r
      ORDER BY r.id DESC
    `);
    res.json(results);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/superadmin/restaurantes/:id', verificarSuperAdmin, async (req, res, next) => {
  const idRestaurante = req.params.id;

  db.getConnection(async (connErr, connection) => {
    if (connErr) return next(connErr);

    try {
      await new Promise((resolve, reject) => connection.beginTransaction(err => err ? reject(err) : resolve()));

      const runQuery = (sql, params) => new Promise((resolve, reject) =>
        connection.query(sql, params, (err) => err ? reject(err) : resolve())
      );

      await runQuery('DELETE FROM detalle_pedidos WHERE pedido_id IN (SELECT id FROM pedidos WHERE restaurante_id = ?)', [idRestaurante]);
      await runQuery('DELETE FROM pedidos WHERE restaurante_id = ?', [idRestaurante]);
      await runQuery('DELETE FROM gastos WHERE restaurante_id = ?', [idRestaurante]);
      await runQuery('DELETE FROM platos WHERE restaurante_id = ?', [idRestaurante]);
      await runQuery('DELETE FROM usuarios WHERE restaurante_id = ?', [idRestaurante]);
      await runQuery('DELETE FROM restaurantes WHERE id = ?', [idRestaurante]);

      await new Promise((resolve, reject) => connection.commit(err => err ? reject(err) : resolve()));
      connection.release();

      logger.info(`Franquicia ID ${idRestaurante} eliminada en cascada.`);
      res.json({ exito: true, mensaje: 'Franquicia eliminada completamente de la base de datos.' });
    } catch (err) {
      connection.rollback(() => connection.release());
      next(err);
    }
  });
});

// ==========================================
// CONFIGURACIÓN DE FRANQUICIA (MARCA BLANCA)
// ==========================================
app.put('/api/restaurantes/tema', verificarToken, async (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden modificar el tema.' });
  }
  const { color_tema } = req.body;
  if (!color_tema) return res.status(400).json({ error: 'El color del tema es requerido.' });

  try {
    await query('UPDATE restaurantes SET color_tema = ? WHERE id = ?', [color_tema, req.usuario.restaurante_id]);
    res.json({ exito: true, mensaje: 'Tema actualizado correctamente.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// CREACIÓN DE EMPLEADOS (PERSONAL)
// ==========================================
app.post('/api/usuarios', verificarToken, validar(schemas.crearUsuario), async (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden registrar personal.' });
  }
  const { nombre, pin, rol } = req.body;

  try {
    const existing = await query(
      'SELECT id FROM usuarios WHERE pin = ? AND restaurante_id = ?',
      [pin, req.usuario.restaurante_id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'El PIN ya está en uso por otro empleado en tu restaurante.' });
    }
    await query(
      'INSERT INTO usuarios (nombre, pin, rol, restaurante_id, estado) VALUES (?, ?, ?, ?, true)',
      [nombre, pin, rol, req.usuario.restaurante_id]
    );
    res.status(201).json({ exito: true, mensaje: 'Personal registrado correctamente.' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/usuarios/restaurante', verificarToken, async (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden ver el personal.' });
  }
  try {
    const results = await query(
      'SELECT id, nombre, rol, pin, estado FROM usuarios WHERE restaurante_id = ? ORDER BY id DESC',
      [req.usuario.restaurante_id]
    );
    res.json(results);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/usuarios/:id', verificarToken, async (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores pueden eliminar personal.' });
  }
  if (parseInt(req.params.id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes auto-eliminarte del sistema.' });
  }
  try {
    await query('DELETE FROM usuarios WHERE id = ? AND restaurante_id = ?', [req.params.id, req.usuario.restaurante_id]);
    res.json({ exito: true, mensaje: 'Personal eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// RUTAS DE ADMINISTRACIÓN DE MENÚ (PLATOS)
// ==========================================
app.get('/api/platos', verificarToken, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM platos WHERE restaurante_id = ?', [req.usuario.restaurante_id]);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/platos', verificarToken, validar(schemas.crearPlato), async (req, res, next) => {
  const { nombre, descripcion, precio, categoria } = req.body;
  try {
    const result = await query(
      'INSERT INTO platos (nombre, descripcion, precio, categoria, restaurante_id) VALUES (?, ?, ?, ?, ?)',
      [nombre, descripcion, precio, categoria, req.usuario.restaurante_id]
    );
    res.json({ exito: true, id: result.insertId, mensaje: '¡Plato agregado al menú!' });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/platos/:id', verificarToken, async (req, res, next) => {
  try {
    await query('DELETE FROM platos WHERE id = ? AND restaurante_id = ?', [req.params.id, req.usuario.restaurante_id]);
    res.json({ exito: true, mensaje: 'Plato eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// RUTAS DE PEDIDOS
// ==========================================
app.get('/api/pedidos/activos', verificarToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
             (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
              FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
      FROM pedidos p
      WHERE p.estado NOT IN ('Cobrado', 'Anulado') AND p.restaurante_id = ?
      ORDER BY p.id ASC
    `, [req.usuario.restaurante_id]);

    const pedidosFormateados = result.map(p => ({
      id: p.id, mesa: p.mesa, estado: p.estado,
      total: Number(p.total), tiempo: 'Reciente',
      items: p.items_desc ? p.items_desc.split(', ') : []
    }));
    res.json(pedidosFormateados);
  } catch (err) {
    next(err);
  }
});

app.get('/api/pedidos/anulados', verificarToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
             (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
              FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
      FROM pedidos p
      WHERE p.estado = 'Anulado' AND p.restaurante_id = ?
      ORDER BY p.fecha_creacion DESC
    `, [req.usuario.restaurante_id]);

    const pedidosFormateados = result.map(p => ({
      id: p.id, mesa: p.mesa, estado: p.estado,
      total: Number(p.total), tiempo: 'Reciente',
      items: p.items_desc ? p.items_desc.split(', ') : []
    }));
    res.json(pedidosFormateados);
  } catch (err) {
    next(err);
  }
});

app.put('/api/pedidos/:id/estado', verificarToken, async (req, res, next) => {
  const idPedido = req.params.id;
  const nuevoEstado = req.body.estado;
  try {
    await query(
      'UPDATE pedidos SET estado = ? WHERE id = ? AND restaurante_id = ?',
      [nuevoEstado, idPedido, req.usuario.restaurante_id]
    );
    // Emitir solo al room de este restaurante
    io.to(`restaurante_${req.usuario.restaurante_id}`).emit('cambio_estado_pedido');
    res.json({ mensaje: `Pedido ${idPedido} marcado como ${nuevoEstado}` });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// RUTAS PARA LA CAJA DIARIA
// ==========================================
app.get('/api/caja/movimientos', verificarToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, CONCAT('Cobro Mesa ', mesa) AS descripcion, total AS monto, 'ingreso' AS tipo, fecha_creacion AS fecha_real, DATE_FORMAT(fecha_creacion, '%h:%i %p') AS hora 
      FROM pedidos WHERE estado = 'Cobrado' AND restaurante_id = ?
      UNION ALL
      SELECT id, descripcion, monto, 'gasto' AS tipo, fecha AS fecha_real, DATE_FORMAT(fecha, '%h:%i %p') AS hora 
      FROM gastos WHERE restaurante_id = ?
      ORDER BY fecha_real DESC
    `, [req.usuario.restaurante_id, req.usuario.restaurante_id]);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/caja/gasto', verificarToken, async (req, res, next) => {
  const { descripcion, monto } = req.body;
  if (!descripcion || !monto) return res.status(400).json({ error: 'Descripción y monto son requeridos.' });
  try {
    await query('INSERT INTO gastos (descripcion, monto, restaurante_id) VALUES (?, ?, ?)', [descripcion, monto, req.usuario.restaurante_id]);
    res.status(201).json({ mensaje: 'Gasto registrado con éxito.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// RUTAS DE ESTADÍSTICAS
// ==========================================
app.get('/api/estadisticas/ventas', verificarToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT DATE_FORMAT(fecha_creacion, '%Y-%m-%d') as fecha, SUM(total) as total_ventas
      FROM pedidos
      WHERE estado = 'Cobrado' AND fecha_creacion >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND restaurante_id = ?
      GROUP BY fecha ORDER BY fecha ASC
    `, [req.usuario.restaurante_id]);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/api/estadisticas/top-platos', verificarToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT plato_nombre as nombre, SUM(cantidad) as ventas
      FROM detalle_pedidos dp
      JOIN pedidos p ON dp.pedido_id = p.id
      WHERE p.estado = 'Cobrado' AND p.restaurante_id = ?
      GROUP BY plato_nombre ORDER BY ventas DESC LIMIT 5
    `, [req.usuario.restaurante_id]);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ==========================================
// ENDPOINTS PÚBLICOS (QR) SIN TOKEN
// ==========================================
app.get('/api/publico/menu/:idLocal', async (req, res, next) => {
  const { idLocal } = req.params;
  try {
    const resRestaurante = await query('SELECT nombre_negocio, color_tema FROM restaurantes WHERE id = ?', [idLocal]);
    if (resRestaurante.length === 0) return res.status(404).json({ error: 'Restaurante no encontrado.' });
    const resPlatos = await query('SELECT * FROM platos WHERE restaurante_id = ?', [idLocal]);
    res.json({ restaurante: resRestaurante[0], platos: resPlatos });
  } catch (err) {
    next(err);
  }
});

app.post('/api/publico/pedidos', validar(schemas.pedidoPublico), async (req, res, next) => {
  const { mesa, total, items, restaurante_id } = req.body;

  try {
    const result = await query(
      'INSERT INTO pedidos (mesa, total, restaurante_id) VALUES (?, ?, ?)',
      [mesa, total, restaurante_id]
    );
    const nuevoPedidoId = result.insertId;

    if (items && items.length > 0) {
      const valoresDetalle = items.map(item => [nuevoPedidoId, item.nombre, item.cantidad, item.subtotal]);
      await query('INSERT INTO detalle_pedidos (pedido_id, plato_nombre, cantidad, subtotal) VALUES ?', [valoresDetalle]);
    }

    // Emitir solo al room del restaurante correspondiente
    io.to(`restaurante_${restaurante_id}`).emit('nuevo_pedido');
    logger.info(`Nuevo pedido #${nuevoPedidoId} para restaurante ${restaurante_id}, mesa ${mesa}`);
    res.status(201).json({ mensaje: '¡Pedido registrado con éxito!', id: nuevoPedidoId });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// MANEJO DE ERRORES GLOBAL
// ==========================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Error en ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Error interno del servidor. Por favor intenta de nuevo.' });
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Servidor Backend multi-tenant corriendo en http://localhost:${PORT}`);
  logger.info(`Orígenes CORS permitidos: ${allowedOrigins.join(', ')}`);
});