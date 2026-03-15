require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();

// Permite que React se conecte al backend
app.use(cors());
// Permite que el servidor entienda datos en formato JSON
app.use(express.json());

// 1. Configuración de la conexión a MySQL
// 1. Configuración de la conexión a MySQL (Usando variables seguras)
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

// 2. Creamos una "Ruta" (Endpoint) para pedir los platos
app.get('/api/platos', (req, res) => {
  const sql = "SELECT * FROM platos";

  db.query(sql, (err, result) => {
    if (err) {
      res.status(500).send('Error obteniendo los platos');
      return;
    }
    // Si todo sale bien, enviamos los datos a React
    res.json(result);
  });
});

// --- RUTAS PARA EL PANEL DE ADMINISTRACIÓN ---

// 1. OBTENER todos los pedidos activos (Pendientes o Listos)
app.get('/api/pedidos/activos', (req, res) => {
  // Esta consulta mágica une la cabecera del pedido con los platos que pidieron
  const sql = `
    SELECT p.id, p.mesa, p.estado, p.total, p.fecha_creacion,
           (SELECT GROUP_CONCAT(CONCAT(cantidad, 'x ', plato_nombre) SEPARATOR ', ')
            FROM detalle_pedidos dp WHERE dp.pedido_id = p.id) as items_desc
    FROM pedidos p
    WHERE p.estado != 'Cobrado'
    ORDER BY p.id ASC
  `;

  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: 'Error obteniendo pedidos' });

    // Formateamos los datos para que React los entienda fácil
    const pedidosFormateados = result.map(p => ({
      id: p.id,
      mesa: p.mesa,
      estado: p.estado,
      total: Number(p.total),
      tiempo: 'Reciente', // Podríamos calcular los minutos reales aquí después
      items: p.items_desc ? p.items_desc.split(', ') : []
    }));

    res.json(pedidosFormateados);
  });
});

// ==========================================
// RUTA DE SEGURIDAD: LOGIN CON PIN
// ==========================================
app.post('/api/login', (req, res) => {
  const { pin } = req.body;

  // 1. Verificamos que el usuario sí haya enviado un PIN
  if (!pin) {
    return res.status(400).json({ error: 'Por favor, ingresa tu PIN.' });
  }

  // 2. Buscamos en la base de datos (El símbolo "?" nos protege de hackers / Inyección SQL)
  const sql = 'SELECT id, nombre, rol FROM usuarios WHERE pin = ? AND estado = true';

  db.query(sql, [pin], (err, results) => {
    if (err) {
      console.error('Error al intentar iniciar sesión:', err);
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }

    // 3. Revisamos si encontramos al usuario
    if (results.length > 0) {
      // ¡PIN correcto! Le devolvemos los datos del trabajador (sin el PIN, por seguridad)
      const usuarioEncontrado = results[0];
      res.json({
        exito: true,
        mensaje: `¡Bienvenido, ${usuarioEncontrado.nombre}!`,
        usuario: usuarioEncontrado
      });
    } else {
      // PIN incorrecto o usuario inactivo
      res.status(401).json({
        exito: false,
        error: 'PIN incorrecto. Intenta de nuevo.'
      });
    }
  });
});

// 2. ACTUALIZAR el estado de un pedido (Ej: pasarlo a "Listo" o "Cobrado")
app.put('/api/pedidos/:id/estado', (req, res) => {
  const idPedido = req.params.id;
  const nuevoEstado = req.body.estado;

  const sql = "UPDATE pedidos SET estado = ? WHERE id = ?";
  db.query(sql, [nuevoEstado, idPedido], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error actualizando estado' });
    res.json({ mensaje: `Pedido ${idPedido} marcado como ${nuevoEstado}` });
  });
});

// --- RUTAS PARA LA CAJA DIARIA ---

// 1. GUARDAR un nuevo gasto
app.post('/api/caja/gasto', (req, res) => {
  const { descripcion, monto } = req.body;
  const sql = "INSERT INTO gastos (descripcion, monto) VALUES (?, ?)";

  db.query(sql, [descripcion, monto], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error guardando el gasto' });
    res.status(201).json({ mensaje: 'Gasto registrado con éxito' });
  });
});

// 2. OBTENER todos los movimientos (Ingresos unidos con Gastos)
app.get('/api/caja/movimientos', (req, res) => {
  // TRUCO SQL (UNION ALL): Juntamos la tabla de pedidos con la tabla de gastos en una sola lista
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

    // Como MySQL ya nos devuelve el formato 'ingreso' o 'gasto', React lo lee directo
    res.json(result);
  });
});

// 3. Encendemos el servidor en el puerto 3001
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor Backend corriendo en http://localhost:${PORT}`);
});

// Ruta para RECIBIR un nuevo pedido desde React
app.post('/api/pedidos', (req, res) => {
  // Extraemos los datos que nos enviará React (ej. { mesa: 4, total: 18.50, items: [...] })
  const { mesa, total, items } = req.body;

  // 1. Primero insertamos la cabecera del pedido
  const sqlPedido = "INSERT INTO pedidos (mesa, total) VALUES (?, ?)";

  db.query(sqlPedido, [mesa, total], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al guardar el pedido' });
    }

    const nuevoPedidoId = result.insertId; // El ID que MySQL le asignó a este pedido

    // 2. Si hay platos (items), los guardamos en el detalle
    if (items && items.length > 0) {
      // Preparamos los datos para insertarlos de golpe
      const valoresDetalle = items.map(item => [nuevoPedidoId, item.nombre, item.cantidad, item.subtotal]);
      const sqlDetalle = "INSERT INTO detalle_pedidos (pedido_id, plato_nombre, cantidad, subtotal) VALUES ?";

      db.query(sqlDetalle, [valoresDetalle], (errDetalle) => {
        if (errDetalle) {
          console.error(errDetalle);
          return res.status(500).json({ error: 'Error al guardar el detalle del pedido' });
        }
        // Todo salió perfecto
        res.status(201).json({ mensaje: '¡Pedido registrado con éxito!', id: nuevoPedidoId });
      });
    } else {
      // Si por alguna razón enviaron un pedido sin platos
      res.status(201).json({ mensaje: 'Pedido creado sin platos (solo cabecera)', id: nuevoPedidoId });
    }
  });
});