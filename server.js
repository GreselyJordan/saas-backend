require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const SECRET_KEY = process.env.JWT_SECRET || 'huecas-super-secret-key';

// ==========================================
// CONFIGURACIÓN DE MIDDLEWARES
// ==========================================
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURACIÓN DE LA CONEXIÓN A MYSQL
// ==========================================
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  }
});

db.connect((err) => {
  if (err) {
    console.error('Error conectando a MySQL:', err);
    return;
  }
  console.log('¡Conectado a la base de datos MySQL con éxito!');
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

// ==========================================
// RUTAS DE SEGURIDAD: LOGIN
// ==========================================
app.post('/api/login', (req, res) => {
  const { pin, codigo_restaurante } = req.body;

  if (!pin || !codigo_restaurante) {
    return res.status(400).json({ error: 'Falta el PIN o el Código del Restaurante.' });
  }

  // 1. Buscamos a qué restaurante pertenece ese código textualmente (Ej: 'mi-hueca')
  const sqlRestaurante = 'SELECT id FROM restaurantes WHERE codigo_acceso = ?';

  db.query(sqlRestaurante, [codigo_restaurante], (err, resRestaurantes) => {
    if (err) return res.status(500).json({ error: 'Error validando tu franquicia.' });
    if (resRestaurantes.length === 0) return res.status(404).json({ error: 'Este código de restaurante no existe.' });

    const idDelRestaurante = resRestaurantes[0].id;

    // 2. Ahora buscamos si el PIN pertenece A ESE RESTAURANTE en específico y traemos sus colores
    const sqlUser = `
      SELECT u.id, u.nombre, u.rol, u.restaurante_id, r.nombre_negocio, r.color_tema 
      FROM usuarios u 
      JOIN restaurantes r ON u.restaurante_id = r.id 
      WHERE u.pin = ? AND u.estado = true AND u.restaurante_id = ?
    `;
    
    db.query(sqlUser, [pin, idDelRestaurante], (err2, results) => {
      if (err2) return res.status(500).json({ error: 'Error interno del servidor.' });

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

        res.json({ exito: true, mensaje: `¡Bienvenido, ${usuarioEncontrado.nombre}!`, usuario: usuarioEncontrado, token });
      } else {
        res.status(401).json({ exito: false, error: 'PIN incorrecto para este restaurante.' });
      }
    });
  });
});

// ==========================================
// MODO DIOS: SÚPER ADMIN (CREAR FRANQUICIAS)
// ==========================================
app.post('/api/superadmin/restaurantes', (req, res) => {
  const { nombre_negocio, codigo_acceso, clave_secreta } = req.body;

  // ¡Cambiamos esto por una clave súper segura solo tuya!
  if (clave_secreta !== 'DsyHVJ24fT6B1uMOJFub') {
    return res.status(403).json({ error: 'Llave de Súper Administrador inválida.' });
  }

  if (!nombre_negocio || !codigo_acceso) {
    return res.status(400).json({ error: 'Faltan datos de la franquicia.' });
  }

  const sqlRestaurante = "INSERT INTO restaurantes (nombre_negocio, codigo_acceso) VALUES (?, ?)";
  
  db.query(sqlRestaurante, [nombre_negocio, codigo_acceso], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ese código de acceso ya está en uso por otro restaurante.' });
      return res.status(500).json({ error: 'Error creando la franquicia.' });
    }

    const nuevoRestauranteId = result.insertId;
    const pinInicial = '1234'; // PIN por defecto para el dueño

    const sqlPrimerUsuario = "INSERT INTO usuarios (nombre, pin, rol, restaurante_id, estado) VALUES (?, ?, 'admin', ?, true)";
    db.query(sqlPrimerUsuario, ['Dueño ' + nombre_negocio, pinInicial, nuevoRestauranteId], (errUser) => {
      if (errUser) return res.status(500).json({ error: 'Franquicia creada, pero falló la creación del usuario administrador.' });
      
      res.status(201).json({ 
        exito: true, 
        mensaje: `¡Franquicia ${nombre_negocio} creada con éxito!`,
        datos: {
          codigo_acceso: codigo_acceso,
          pin_inicial: pinInicial
        }
      });
    });
  });
});

app.get('/api/superadmin/restaurantes', (req, res) => {
  const llavendn = req.headers['x-super-admin-key'];
  if (llavendn !== 'DsyHVJ24fT6B1uMOJFub') {
    return res.status(403).json({ error: 'Acceso denegado. No eres el creador elástica.' });
  }

  const sql = `
    SELECT r.id, r.nombre_negocio, r.codigo_acceso,
           (SELECT COUNT(*) FROM usuarios u WHERE u.restaurante_id = r.id) as total_empleados,
           (SELECT COUNT(*) FROM pedidos p WHERE p.restaurante_id = r.id) as total_pedidos
    FROM restaurantes r
    ORDER BY r.id DESC
  `;
  
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Fallo SQL Crítico: ' + err.message });
    res.json(results);
  });
});

app.delete('/api/superadmin/restaurantes/:id', (req, res) => {
  const llavendn = req.headers['x-super-admin-key'];
  if (llavendn !== 'DsyHVJ24fT6B1uMOJFub') {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }

  const idRestaurante = req.params.id;

  // Borrado Manual en Cascada para evitar errores de Foreign Key si no fue seteado on DB
  const sqlBorrarDetallesPedidos = `DELETE FROM detalle_pedidos WHERE pedido_id IN (SELECT id FROM pedidos WHERE restaurante_id = ?)`;
  const sqlBorrarPedidos = `DELETE FROM pedidos WHERE restaurante_id = ?`;
  const sqlBorrarGastos = `DELETE FROM gastos WHERE restaurante_id = ?`;
  const sqlBorrarPlatos = `DELETE FROM platos WHERE restaurante_id = ?`;
  const sqlBorrarUsuarios = `DELETE FROM usuarios WHERE restaurante_id = ?`;
  const sqlBorrarRestaurante = `DELETE FROM restaurantes WHERE id = ?`;

  db.query(sqlBorrarDetallesPedidos, [idRestaurante], (err1) => {
    if (err1) return res.status(500).json({ error: 'Error borrando historial de detalles.' });
    db.query(sqlBorrarPedidos, [idRestaurante], (err2) => {
      if (err2) return res.status(500).json({ error: 'Error borrando pedidos.' });
      db.query(sqlBorrarGastos, [idRestaurante], (err3) => {
        db.query(sqlBorrarPlatos, [idRestaurante], (err4) => {
          db.query(sqlBorrarUsuarios, [idRestaurante], (err5) => {
            db.query(sqlBorrarRestaurante, [idRestaurante], (err6) => {
              if (err6) return res.status(500).json({ error: 'Fallo catastrófico borrando restaurante base.' });
              res.json({ exito: true, mensaje: 'Franquicia obliterada completamente de la base de datos (En cascada).' });
            });
          });
        });
      });
    });
  });
});

// ==========================================
// CONFIGURACIÓN DE FRANQUICIA (MARCA BLANCA)
// ==========================================
app.put('/api/restaurantes/tema', verificarToken, (req, res) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden modificar el tema.' });
  }

  const { color_tema } = req.body;
  if (!color_tema) {
    return res.status(400).json({ error: 'El color del tema es requerido.' });
  }

  const sql = "UPDATE restaurantes SET color_tema = ? WHERE id = ?";
  db.query(sql, [color_tema, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error interno al guardar tu color.' });
    res.json({ exito: true, mensaje: 'Tema actualizado exquisitamente.' });
  });
});

// ==========================================
// CREACIÓN DE EMPLEADOS (PERSONAL)
// ==========================================
app.post('/api/usuarios', verificarToken, (req, res) => {
  // Solo los admin pueden crear personal
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden registrar personal.' });
  }

  const { nombre, pin, rol } = req.body;
  if (!nombre || !pin || !rol) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  // Verificamos que no exista el pin en ESTE restaurante
  db.query('SELECT id FROM usuarios WHERE pin = ? AND restaurante_id = ?', [pin, req.usuario.restaurante_id], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error interno validando.' });
    if (results.length > 0) return res.status(400).json({ error: 'El PIN ya está en uso por otro empleado en tu restaurante.' });

    // Explicitly set estado = true for new users
    const sql = 'INSERT INTO usuarios (nombre, pin, rol, restaurante_id, estado) VALUES (?, ?, ?, ?, true)';
    db.query(sql, [nombre, pin, rol, req.usuario.restaurante_id], (insertErr, result) => {
      if (insertErr) return res.status(500).json({ error: 'Error guardando usuario.' });
      res.status(201).json({ exito: true, mensaje: 'Personal registrado correctamente.' });
    });
  });
});

app.get('/api/usuarios/restaurante', verificarToken, (req, res) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden ver el personal.' });
  }

  const sql = "SELECT id, nombre, rol, pin, estado FROM usuarios WHERE restaurante_id = ? ORDER BY id DESC";
  db.query(sql, [req.usuario.restaurante_id], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo la lista de personal.' });
    res.json(results);
  });
});

app.delete('/api/usuarios/:id', verificarToken, (req, res) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores pueden eliminar personal.' });
  }
  
  // Evitar que el administrador se borre a sí mismo accidentalmente
  if (parseInt(req.params.id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes auto-eliminarte del sistema.' });
  }

  const sql = "DELETE FROM usuarios WHERE id = ? AND restaurante_id = ?";
  db.query(sql, [req.params.id, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al eliminar el empleado.' });
    res.json({ exito: true, mensaje: 'Personal eliminado/despedido correctamente.' });
  });
});

// ==========================================
// RUTAS DE ADMINISTRACIÓN DE MENÚ (PLATOS)
// ==========================================

app.get('/api/platos', verificarToken, (req, res) => {
  const sql = "SELECT * FROM platos WHERE restaurante_id = ?";
  db.query(sql, [req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).send('Error obteniendo los platos');
    res.json(result);
  });
});

app.post('/api/platos', verificarToken, (req, res) => {
  const { nombre, descripcion, precio, categoria } = req.body;
  
  if (!nombre || !precio || !categoria) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const sql = 'INSERT INTO platos (nombre, descripcion, precio, categoria, restaurante_id) VALUES (?, ?, ?, ?, ?)';
  db.query(sql, [nombre, descripcion, precio, categoria, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al guardar en la base de datos' });
    res.json({ exito: true, id: result.insertId, mensaje: '¡Plato agregado al menú!' });
  });
});

app.delete('/api/platos/:id', verificarToken, (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM platos WHERE id = ? AND restaurante_id = ?';
  db.query(sql, [id, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al eliminar de la base de datos' });
    res.json({ exito: true, mensaje: 'Plato eliminado correctamente' });
  });
});

// ==========================================
// RUTAS DE PEDIDOS (Área Privada - Cocina)
// ==========================================

app.get('/api/pedidos/activos', verificarToken, (req, res) => {
  const sql = `
    SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
           (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
            FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
    FROM pedidos p
    WHERE p.estado NOT IN ('Cobrado', 'Anulado') AND p.restaurante_id = ?
    ORDER BY p.id ASC
  `;
  db.query(sql, [req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo pedidos' });

    const pedidosFormateados = result.map(p => ({
      id: p.id,
      mesa: p.mesa,
      estado: p.estado,
      total: Number(p.total),
      tiempo: 'Reciente', 
      items: p.items_desc ? p.items_desc.split(', ') : []
    }));
    res.json(pedidosFormateados);
  });
});

app.get('/api/pedidos/anulados', verificarToken, (req, res) => {
  const sql = `
    SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
           (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
            FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
    FROM pedidos p
    WHERE p.estado = 'Anulado' AND p.restaurante_id = ?
    ORDER BY p.fecha_creacion DESC
  `;
  db.query(sql, [req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo pedidos anulados' });

    const pedidosFormateados = result.map(p => ({
      id: p.id,
      mesa: p.mesa,
      estado: p.estado,
      total: Number(p.total),
      tiempo: 'Reciente', 
      items: p.items_desc ? p.items_desc.split(', ') : []
    }));
    res.json(pedidosFormateados);
  });
});

app.put('/api/pedidos/:id/estado', verificarToken, (req, res) => {
  const idPedido = req.params.id;
  const nuevoEstado = req.body.estado;

  const sql = "UPDATE pedidos SET estado = ? WHERE id = ? AND restaurante_id = ?";
  db.query(sql, [nuevoEstado, idPedido, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error actualizando estado' });
    io.emit('cambio_estado_pedido'); // Notificar a los meseros/clientes si queremos
    res.json({ mensaje: `Pedido ${idPedido} marcado como ${nuevoEstado}` });
  });
});

// ==========================================
// RUTAS PARA LA CAJA DIARIA
// ==========================================

app.get('/api/caja/movimientos', verificarToken, (req, res) => {
  const sql = `
    SELECT id, CONCAT('Cobro Mesa ', mesa) AS descripcion, total AS monto, 'ingreso' AS tipo, fecha_creacion AS fecha_real, DATE_FORMAT(fecha_creacion, '%h:%i %p') AS hora 
    FROM pedidos WHERE estado = 'Cobrado' AND restaurante_id = ?
    
    UNION ALL
    
    SELECT id, descripcion, monto, 'gasto' AS tipo, fecha AS fecha_real, DATE_FORMAT(fecha, '%h:%i %p') AS hora 
    FROM gastos WHERE restaurante_id = ?
    
    ORDER BY fecha_real DESC
  `;
  db.query(sql, [req.usuario.restaurante_id, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo la caja' });
    res.json(result);
  });
});

app.post('/api/caja/gasto', verificarToken, (req, res) => {
  const { descripcion, monto } = req.body;
  const sql = "INSERT INTO gastos (descripcion, monto, restaurante_id) VALUES (?, ?, ?)";
  db.query(sql, [descripcion, monto, req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error guardando el gasto' });
    res.status(201).json({ mensaje: 'Gasto registrado con éxito' });
  });
});

// ==========================================
// RUTAS DE ESTADÍSTICAS
// ==========================================

app.get('/api/estadisticas/ventas', verificarToken, (req, res) => {
  const sql = `
    SELECT DATE_FORMAT(fecha_creacion, '%Y-%m-%d') as fecha, SUM(total) as total_ventas
    FROM pedidos
    WHERE estado = 'Cobrado' AND fecha_creacion >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND restaurante_id = ?
    GROUP BY fecha
    ORDER BY fecha ASC
  `;
  db.query(sql, [req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo estadísticas' });
    res.json(result);
  });
});

app.get('/api/estadisticas/top-platos', verificarToken, (req, res) => {
  const sql = `
    SELECT plato_nombre as nombre, SUM(cantidad) as ventas
    FROM detalle_pedidos dp
    JOIN pedidos p ON dp.pedido_id = p.id
    WHERE p.estado = 'Cobrado' AND p.restaurante_id = ?
    GROUP BY plato_nombre
    ORDER BY ventas DESC
    LIMIT 5
  `;
  db.query(sql, [req.usuario.restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo top platos' });
    res.json(result);
  });
});

// ==========================================
// NUEVO: PUBLIC ENDPOINTS (QR) SIN TOKEN
// ==========================================

// Obtener menú y configuración del restaurante de forma pública
app.get('/api/publico/menu/:idLocal', (req, res) => {
  const { idLocal } = req.params;
  
  const sqlRestaurante = "SELECT nombre_negocio, color_tema FROM restaurantes WHERE id = ?";
  const sqlPlatos = "SELECT * FROM platos WHERE restaurante_id = ?";
  
  db.query(sqlRestaurante, [idLocal], (err, resRestaurante) => {
    if (err || resRestaurante.length === 0) return res.status(500).json({ error: 'Error obteniendo restaurante' });
    
    db.query(sqlPlatos, [idLocal], (err2, resPlatos) => {
      if (err2) return res.status(500).json({ error: 'Error obteniendo los platos' });
      
      res.json({
        restaurante: resRestaurante[0],
        platos: resPlatos
      });
    });
  });
});

// Enviar pedido desde el QR (Requiere enviar el idLocal en el body)
app.post('/api/publico/pedidos', (req, res) => {
  const { mesa, total, items, restaurante_id } = req.body;

  if (!restaurante_id) return res.status(400).json({ error: 'El ID del restaurante es obligatorio' });

  const sqlPedido = "INSERT INTO pedidos (mesa, total, restaurante_id) VALUES (?, ?, ?)";

  db.query(sqlPedido, [mesa, total, restaurante_id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al guardar el pedido' });

    const nuevoPedidoId = result.insertId; 

    if (items && items.length > 0) {
      const valoresDetalle = items.map(item => [nuevoPedidoId, item.nombre, item.cantidad, item.subtotal]);
      const sqlDetalle = "INSERT INTO detalle_pedidos (pedido_id, plato_nombre, cantidad, subtotal) VALUES ?";

      db.query(sqlDetalle, [valoresDetalle], (errDetalle) => {
        if (errDetalle) return res.status(500).json({ error: 'Error al guardar el detalle del pedido' });
        
        io.emit('nuevo_pedido'); // Se notifica a TODAS las cocinas, el Frontend de cocina filtrará o simplemente recargará.
        res.status(201).json({ mensaje: '¡Pedido registrado con éxito!', id: nuevoPedidoId });
      });
    } else {
      io.emit('nuevo_pedido');
      res.status(201).json({ mensaje: 'Pedido creado sin platos (solo cabecera)', id: nuevoPedidoId });
    }
  });
});


// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor Backend multi-tenant corriendo en http://localhost:${PORT}`);
});