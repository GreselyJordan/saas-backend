require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ==========================================
// CONFIGURACIÓN DE MIDDLEWARES
// ==========================================
// Permite que React se conecte al backend
app.use(cors());
// Permite que el servidor entienda datos en formato JSON
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
    rejectUnauthorized: false // Permite la conexión segura requerida por Aiven
  }
});

// Conectamos a la base de datos
db.connect((err) => {
  if (err) {
    console.error('Error conectando a MySQL:', err);
    return;
  }
  console.log('¡Conectado a la base de datos MySQL con éxito!');
});

// ==========================================
// RUTAS DE SEGURIDAD: LOGIN
// ==========================================

// Login con PIN
app.post('/api/login', (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: 'Por favor, ingresa tu PIN.' });
  }

  const sql = 'SELECT id, nombre, rol FROM usuarios WHERE pin = ? AND estado = true';

  db.query(sql, [pin], (err, results) => {
    if (err) {
      console.error('Error al intentar iniciar sesión:', err);
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }

    if (results.length > 0) {
      const usuarioEncontrado = results[0];
      res.json({
        exito: true,
        mensaje: `¡Bienvenido, ${usuarioEncontrado.nombre}!`,
        usuario: usuarioEncontrado
      });
    } else {
      res.status(401).json({
        exito: false,
        error: 'PIN incorrecto. Intenta de nuevo.'
      });
    }
  });
});

// ==========================================
// RUTAS DE ADMINISTRACIÓN DE MENÚ (PLATOS)
// ==========================================

// 1. Obtener todos los platos
app.get('/api/platos', (req, res) => {
  const sql = "SELECT * FROM platos";

  db.query(sql, (err, result) => {
    if (err) {
      return res.status(500).send('Error obteniendo los platos');
    }
    res.json(result);
  });
});

// 2. Agregar un plato nuevo
app.post('/api/platos', (req, res) => {
  const { nombre, descripcion, precio, categoria } = req.body;
  
  if (!nombre || !precio || !categoria) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const sql = 'INSERT INTO platos (nombre, descripcion, precio, categoria) VALUES (?, ?, ?, ?)';
  db.query(sql, [nombre, descripcion, precio, categoria], (err, result) => {
    if (err) {
      console.error('Error al guardar plato:', err);
      return res.status(500).json({ error: 'Error al guardar en la base de datos' });
    }
    res.json({ exito: true, id: result.insertId, mensaje: '¡Plato agregado al menú!' });
  });
});

// 3. Eliminar un plato
app.delete('/api/platos/:id', (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM platos WHERE id = ?';
  
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('Error al eliminar plato:', err);
      return res.status(500).json({ error: 'Error al eliminar de la base de datos' });
    }
    res.json({ exito: true, mensaje: 'Plato eliminado correctamente' });
  });
});

// ==========================================
// RUTAS DE PEDIDOS
// ==========================================

// 1. Obtener todos los pedidos activos (Pendientes o Listos)
app.get('/api/pedidos/activos', (req, res) => {
  const sql = `
    SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
           (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
            FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
    FROM pedidos p
    WHERE p.estado NOT IN ('Cobrado', 'Anulado')
    ORDER BY p.id ASC
  `;

  db.query(sql, (err, result) => {
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

// 1.5 Obtener todos los pedidos anulados
app.get('/api/pedidos/anulados', (req, res) => {
  const sql = `
    SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
           (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
            FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
    FROM pedidos p
    WHERE p.estado = 'Anulado'
    ORDER BY p.fecha_creacion DESC
  `;

  db.query(sql, (err, result) => {
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

// 2. Crear un nuevo pedido
app.post('/api/pedidos', (req, res) => {
  const { mesa, total, items } = req.body;

  const sqlPedido = "INSERT INTO pedidos (mesa, total) VALUES (?, ?)";

  db.query(sqlPedido, [mesa, total], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al guardar el pedido' });
    }

    const nuevoPedidoId = result.insertId; 

    if (items && items.length > 0) {
      const valoresDetalle = items.map(item => [nuevoPedidoId, item.nombre, item.cantidad, item.subtotal]);
      const sqlDetalle = "INSERT INTO detalle_pedidos (pedido_id, plato_nombre, cantidad, subtotal) VALUES ?";

      db.query(sqlDetalle, [valoresDetalle], (errDetalle) => {
        if (errDetalle) {
          console.error(errDetalle);
          return res.status(500).json({ error: 'Error al guardar el detalle del pedido' });
        }
        io.emit('nuevo_pedido'); // <--- NOTIFICACIÓN SOCKET.IO
        res.status(201).json({ mensaje: '¡Pedido registrado con éxito!', id: nuevoPedidoId });
      });
    } else {
      io.emit('nuevo_pedido'); // <--- NOTIFICACIÓN SOCKET.IO
      res.status(201).json({ mensaje: 'Pedido creado sin platos (solo cabecera)', id: nuevoPedidoId });
    }
  });
});

// 3. Actualizar el estado de un pedido (Ej: pasarlo a "Listo" o "Cobrado")
app.put('/api/pedidos/:id/estado', (req, res) => {
  const idPedido = req.params.id;
  const nuevoEstado = req.body.estado;

  const sql = "UPDATE pedidos SET estado = ? WHERE id = ?";
  db.query(sql, [nuevoEstado, idPedido], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error actualizando estado' });
    res.json({ mensaje: `Pedido ${idPedido} marcado como ${nuevoEstado}` });
  });
});

// ==========================================
// RUTAS PARA LA CAJA DIARIA
// ==========================================

// 1. Obtener todos los movimientos (Ingresos unidos con Gastos)
app.get('/api/caja/movimientos', (req, res) => {
  const sql = `
    SELECT id, CONCAT('Cobro Mesa ', mesa) AS descripcion, total AS monto, 'ingreso' AS tipo, fecha_creacion AS fecha_real, DATE_FORMAT(fecha_creacion, '%h:%i %p') AS hora 
    FROM pedidos WHERE estado = 'Cobrado'
    
    UNION ALL
    
    SELECT id, descripcion, monto, 'gasto' AS tipo, fecha AS fecha_real, DATE_FORMAT(fecha, '%h:%i %p') AS hora 
    FROM gastos
    
    ORDER BY fecha_real DESC
  `;

  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo la caja' });
    res.json(result);
  });
});

// 2. Guardar un nuevo gasto
app.post('/api/caja/gasto', (req, res) => {
  const { descripcion, monto } = req.body;
  const sql = "INSERT INTO gastos (descripcion, monto) VALUES (?, ?)";

  db.query(sql, [descripcion, monto], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error guardando el gasto' });
    res.status(201).json({ mensaje: 'Gasto registrado con éxito' });
  });
});

// ==========================================
// RUTAS DE ESTADÍSTICAS
// ==========================================

// 1. Obtener ventas de los últimos 7 días
app.get('/api/estadisticas/ventas', (req, res) => {
  const sql = `
    SELECT DATE_FORMAT(fecha_creacion, '%Y-%m-%d') as fecha, SUM(total) as total_ventas
    FROM pedidos
    WHERE estado = 'Cobrado' AND fecha_creacion >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
    GROUP BY fecha
    ORDER BY fecha ASC
  `;
  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo estadísticas' });
    res.json(result);
  });
});

// 2. Obtener los platos más vendidos
app.get('/api/estadisticas/top-platos', (req, res) => {
  const sql = `
    SELECT plato_nombre as nombre, SUM(cantidad) as ventas
    FROM detalle_pedidos dp
    JOIN pedidos p ON dp.pedido_id = p.id
    WHERE p.estado = 'Cobrado'
    GROUP BY plato_nombre
    ORDER BY ventas DESC
    LIMIT 5
  `;
  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo top platos' });
    res.json(result);
  });
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor Backend corriendo en http://localhost:${PORT}`);
});