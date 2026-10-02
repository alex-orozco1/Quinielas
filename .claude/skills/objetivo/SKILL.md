---
name: objetivo
description: Coordina un objetivo de QRACKS con el equipo de subagentes (head-of-product, product-design, product-qa, technical-qa). Úsalo cuando el usuario dé un objetivo de producto o ingeniería con /objetivo o en texto ("Objetivo: …").
argument-hint: <objetivo en una o dos frases>
---

# Coordinar un objetivo

La sesión principal es **Engineering y coordinador**. Implementa y no delega la
implementación. Los subagentes viven en `.claude/agents/`; se invocan con la
herramienta Agent y su `subagent_type`. Cada uno arranca sin la conversación,
así que necesita un prompt autosuficiente.

Objetivo recibido: $ARGUMENTS

## 1. Clasificar (sin agentes)

Decide qué etapas hacen falta. **Invoca sólo los agentes necesarios**:

| Tipo de objetivo | Producto | Diseño | Product QA | Technical QA |
|---|---|---|---|---|
| Feature o cambio de flujo visible | sí | sí | sí | si toca servidor/datos/pagos |
| Cambio de copy o UI menor | no* | sí | sí | no |
| Bug funcional | no* | no | sí | si toca servidor/datos/pagos |
| Bug técnico, datos, seguridad, pagos o concurrencia | no* | no | si hay impacto visible | sí |
| Auditoría o pregunta de sólo lectura | según el tema | según el tema | según el tema | según el tema |
| Refactor sin cambio de comportamiento | no | no | no | sí |

\* Sólo se invoca Producto si el alcance o la prioridad no son obvios.

Una tarea trivial y reversible (typo, test faltante evidente) se hace sin
agentes.

## 2. Producto → 3. Diseño

- `head-of-product` recibe el objetivo, el contexto que tengas (archivos,
  hallazgos previos, restricciones del usuario) y lo que ya se descartó.
  Devuelve prioridad, alcance y criterios de aceptación CA-n.
- `product-design` recibe los CA-n y los archivos relevantes. Devuelve el
  journey [REAL] y las propuestas [PROPUESTA].
- Si Producto y Diseño son independientes (p. ej. una auditoría), lánzalos en
  paralelo en un mismo mensaje.
- Las decisiones que sólo el usuario puede tomar (precio, alcance de negocio,
  algo irreversible) se le preguntan con AskUserQuestion. Las demás las
  resuelves tú.

## 4. Implementación (sesión principal)

- Rama designada por la sesión. Cambios mínimos, tests nuevos o actualizados y
  tests afectados en verde.
- Lo local y reversible se hace solo. **Merge, PR, deploy, env de Render,
  datos de producción y cobros requieren autorización explícita del usuario en
  esta conversación.** Commit y push sólo si el usuario lo pidió para esta
  tarea.

## 5. QA independiente

- Pásale a QA **qué revisar** (los CA-n, el diff o los SHAs, los archivos y
  los riesgos que te preocupan), **no tus conclusiones**. No incluyas "ya
  verifiqué que…" como evidencia.
- `product-qa` y `technical-qa` son independientes entre sí: lánzalos en
  paralelo.
- Cada hallazgo P0–P2 confirmado se corrige y se vuelve a pasar **sólo** por
  el QA que lo encontró, con el diff del fix. No se repite toda la ronda.
- PASS = 0 P0/P1/P2 conocidos en ambos QA.

## Plantilla de prompt para un subagente

```
Objetivo: <1–2 frases>
Rol en esta etapa: <qué decisión o verificación se espera>
Contexto: rama <x>, HEAD <sha>, origin/main <sha>, desplegado <sha|UNKNOWN>,
  archivos <…>, restricciones del usuario <…>
Entradas: <CA-n / journey / diff / hallazgos previos>
Fuera de alcance: <…>
Modo: sólo lectura | puede levantar la app local
Devuelve: evidencia, hallazgos (P0–P3), pendientes/UNKNOWN, en el formato de
tu definición. Máximo ~600 palabras salvo que haga falta más evidencia.
```

## Entrega al usuario

Un resumen con el veredicto, la evidencia clave de cada agente (citando qué
dijo cada uno y qué comprobaste tú), los cambios hechos, los pendientes y lo
que necesita autorización. No pegues el reporte completo de los agentes; el
usuario no lo ve, así que transmite lo que importa.
