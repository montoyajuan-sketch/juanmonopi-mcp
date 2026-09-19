// modules/registro.js
// Asignador central de puertos. Cada modulo YA NO declara un puerto fijo:
// el loader (index.js) le pide un puerto libre a este archivo al cargar
// cada modulo, y se lo pasa a iniciar(puerto). Asi es imposible que dos
// modulos choquen, sin importar cuantos se agreguen despues.

import net from "net";

const RANGO_DESDE = 9000;
const RANGO_HASTA = 9999;

function estaLibre(puerto) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(puerto, "127.0.0.1");
  });
}

// usados: Set de puertos ya asignados en esta misma corrida (para no
// asignar el mismo puerto a dos modulos que cargan casi al mismo tiempo,
// antes de que el primero llegue a abrirlo de verdad).
export async function asignarPuertoLibre(usados) {
  for (let puerto = RANGO_DESDE; puerto <= RANGO_HASTA; puerto++) {
    if (usados.has(puerto)) continue;
    if (await estaLibre(puerto)) {
      usados.add(puerto);
      return puerto;
    }
  }
  throw new Error(`No quedan puertos libres en el rango ${RANGO_DESDE}-${RANGO_HASTA}`);
}
