// UX-INFRA-001 · Textos de la pantalla de carga (propuesta v3, revisión de GPT).
// El texto depende sólo del DESTINO (la ruta). Nada de la URL se imprime en la
// página: sólo se elige uno de estos textos fijos. La app comprueba después la
// existencia de la quiniela y los permisos.

export function destinationFor(pathname) {
  const p = String(pathname || "/");
  if (p === "/crear" || p.startsWith("/crear/")) return "crear";
  if (/^\/q\/[^/]+/.test(p)) return "q";
  if (/^\/a\/[^/]+/.test(p)) return "a";
  return "inicio";
}

export const TITLES = Object.freeze({
  inicio: "Estamos abriendo QRACKS",
  crear: "Estamos preparando el formulario para crear tu quiniela",
  q: "Estamos abriendo tu quiniela",
  a: "Estamos abriendo la administración de tu quiniela",
});

export const TEXT = Object.freeze({
  auto: "La página se abrirá automáticamente cuando esté disponible.",
  slowTitle: "Está tardando más de lo normal",
  slowBody: "Seguimos intentando. La página se abrirá automáticamente cuando esté disponible.",
  errorTitle: "No pudimos abrir QRACKS después de 2 minutos. Puedes reintentar.",
  offlineTitle: "Sin conexión a internet",
  offlineBody: "Tu dispositivo no tiene conexión. Volveremos a intentar cuando regrese.",
  pausedBody: "La pestaña está en segundo plano: retomamos al volver, dentro del plazo de 2 minutos.",
  safe: "Esta pantalla no envía ni modifica tus pronósticos.",
  payment: "Volviste de la página de pago. Cuando QRACKS abra, verás el estado de tu compra tal como lo registre el sistema.",
  retry: "Reintentar",
  retryNow: "Reintentar ahora",
  meanwhile: "Mientras tanto",
  pause: "Pausar",
  resume: "Reanudar",
});

const PARTICIPANT = [
  ["🏆", "Consulta tu posición después de publicar resultados", "Cuando el organizador publica los resultados de una jornada, la tabla muestra tu lugar y tus puntos."],
  ["🔍", "Consulta resultados y pronósticos de jornadas anteriores", "En el historial ves qué pronosticó cada quien en las jornadas ya cerradas y cuántos puntos sumó."],
  ["❓", "Más que partidos", "Tu quiniela puede incluir preguntas extra, como si habrá penales. Las califica el organizador."],
  ["📱", "Entras con tu nombre y tu PIN", "Sin descargar apps ni crear cuentas: desde el celular o la compu, con el enlace de tu quiniela."],
];
const ORGANIZER = [
  ["🔗", "Arma tu quiniela y compártela con un enlace", "Tus amigos entran desde el enlace, sin descargar nada."],
  ["📱", "Entran con su nombre y un PIN", "Sin apps ni cuentas: desde el celular o la compu."],
  ["⭐", "Preguntas y puntos extra", "Además de los partidos, agrega preguntas como si habrá penales. Tú decides cuántos puntos valen y tú calificas quién acertó."],
  ["💵", "Registra las cuotas del grupo", "Marca quién ya cubrió su cuota y, si quieres, resta puntos a quien no. QRACKS sólo lleva el registro: no cobra ni custodia ese dinero."],
  ["🏆", "Puntos y tabla al publicar resultados", "Cuando publicas los resultados de una jornada, QRACKS calcula los puntos y la tabla para todos."],
  ["🚀", "¿Van por todo el torneo? QRACKS Plus", "Con Plus tu quiniela cubre el torneo completo y admite más personas. Se activa desde Admin, cuando lo necesites."],
];

export function tipsFor(dest) {
  if (dest === "q") return PARTICIPANT;
  if (dest === "a") return ORGANIZER.slice(1);
  return ORGANIZER;
}
