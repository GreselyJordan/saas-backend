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
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: 'Por favor, ingresa tu PIN.' });
  }

  const sql = 'SELECT id, nombre, rol, restaurante_id FROM usuarios WHERE pin = ? AND estado = true';

  db.query(sql, [pin], (err, results) => {
    if (err) {
      console.error('Error al intentar iniciar sesión:', err);
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }

    if (results.length > 0) {
      const usuarioEncontrado = results[0];
      
      const token = jwt.sign(
        { id: usuarioEncontrado.id, rol: usuarioEncontrado.rol, restaurante_id: usuarioEncontrado.restaurante_id }, 
        SECRET_KEY, 
        { expiresIn: '12h' }
      );

      res.json({ exito: true, mensaje: `¡Bienvenido, ${usuarioEncontrado.nombre}!`, usuario: usuarioEncontrado, token });
    } else {
      res.status(401).json({ exito: false, error: 'PIN incorrecto. Intenta de nuevo.' });
    }
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

  // Verificamos que no exista el pin
  db.query('SELECT id FROM usuarios WHERE pin = ?', [pin], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error interno validando.' });
    if (results.length > 0) return res.status(400).json({ error: 'El PIN ya existe, escoge otro.' });

    // Explicitly set estado = true for new users
    const sql = 'INSERT INTO usuarios (nombre, pin, rol, restaurante_id, estado) VALUES (?, ?, ?, ?, true)';
    db.query(sql, [nombre, pin, rol, req.usuario.restaurante_id], (insertErr, result) => {
      if (insertErr) return res.status(500).json({ error: 'Error guardando usuario.' });
      res.status(201).json({ exito: true, mensaje: 'Personal registrado correctamente.' });
    });
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

// Obtener menú de un restaurante específico
app.get('/api/publico/menu/:idLocal', (req, res) => {
  const { idLocal } = req.params;
  const sql = "SELECT * FROM platos WHERE restaurante_id = ?";
  db.query(sql, [idLocal], (err, result) => {
    if (err) return res.status(500).send('Error obteniendo los platos');
    res.json(result);
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