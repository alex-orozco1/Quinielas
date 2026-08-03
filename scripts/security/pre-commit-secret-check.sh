#!/usr/bin/env bash
# scripts/security/pre-commit-secret-check.sh
#
# SEC-000.2 (Fase 4) — verificación ligera para detectar, ANTES de comitear,
# los mismos patrones que causaron este incidente. No reemplaza revisión
# humana ni una herramienta dedicada de detección de secretos — es una red
# de seguridad barata y de mantenimiento mínimo.
#
# Costo operativo: cero (sin servicio externo, sin dependencia nueva, es un
# script de shell que usa solo `git` y `grep`, ambos ya presentes).
# Mantenimiento: bajo — es una lista de patrones en texto plano, se edita
# agregando una línea cuando aparezca un patrón nuevo a vigilar.
#
# LÍMITE CONOCIDO E IMPORTANTE: cualquiera puede saltarse este hook con
# `git commit --no-verify` — es una limitación inherente a los hooks
# locales de git, no de este script. Por eso este mismo script también debe
# correr en CI (ver más abajo) — ahí es donde la verificación realmente se
# hace cumplir, el hook local es solo una conveniencia para detectar el
# problema más rápido, antes de llegar a CI.
#
# Instalación local (opcional, por desarrollador):
#   ln -s ../../scripts/security/pre-commit-secret-check.sh .git/hooks/pre-commit
#
# Uso en CI (esto es lo que realmente aplica la regla): correr este mismo
# script como un step más en el pipeline, apuntando a los archivos del
# commit/PR en cuestión — ahí SÍ bloquea el merge sin importar si alguien
# usó --no-verify localmente.

set -euo pipefail

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACM || true)"

if [[ -z "$STAGED_FILES" ]]; then
  exit 0
fi

BLOCKED=0

# Rutas donde SÍ es legítimo tener SQL versionado — si el equipo agrega una
# ubicación nueva de migraciones reales, agregar aquí, no desactivar la regla.
is_legit_sql_path() {
  [[ "$1" =~ ^docs/security/ ]] || [[ "$1" =~ ^migrations/ ]]
}

# 1. Rutas que nunca deberían comitearse, por nombre.
for f in $STAGED_FILES; do
  if [[ "$f" =~ ^backups/ ]] || \
     [[ "$f" =~ \.sql$ ]] && ! is_legit_sql_path "$f"; then
    echo "BLOQUEADO: '$f' coincide con un patrón de archivo que no debe comitearse (backups/ o .sql fuera de docs/security//migrations/)."
    BLOCKED=1
    continue
  fi
  if [[ "$f" =~ ^dumps/ ]] || \
     [[ "$f" =~ ^exports/ ]] || \
     [[ "$f" =~ ^\.env(\..+)?$ ]] || \
     [[ "$f" =~ \.dump$ ]] || \
     [[ "$f" =~ \.bak$ ]] || \
     [[ "$f" =~ \.pem$ ]] || \
     [[ "$f" =~ \.key$ ]]; then
    echo "BLOQUEADO: '$f' coincide con un patrón de archivo que no debe comitearse (dumps/exports/.env/.dump/.bak/.pem/.key)."
    BLOCKED=1
  fi
done

# 2. Patrones de contenido evidentes dentro de los archivos que SÍ se van a comitear.
#    Se revisa el CONTENIDO sin importar el nombre/extensión del archivo, para
#    cubrir el caso de que alguien renombre un archivo sensible (ej. .sql -> .txt)
#    antes de comitearlo.
for f in $STAGED_FILES; do
  [[ -f "$f" ]] || continue
  if grep -qE 'postgres(ql)?://[^:@[:space:]]+:[^@[:space:]]+@' "$f" 2>/dev/null; then
    echo "BLOQUEADO: '$f' contiene lo que parece ser un connection string con credenciales embebidas."
    BLOCKED=1
  fi
  if grep -qE '"ownerPassword"\s*:\s*"[^"]+"' "$f" 2>/dev/null; then
    OWNER_PW_VALUE="$(grep -oE '"ownerPassword"\s*:\s*"[^"]+"' "$f" | head -1 | sed -E 's/.*:\s*"([^"]+)"/\1/')"
    if [[ -n "$OWNER_PW_VALUE" && "$OWNER_PW_VALUE" != scrypt\$* ]]; then
      echo "BLOQUEADO: '$f' contiene un valor de ownerPassword que no parece estar hasheado."
      BLOCKED=1
    fi
  fi
  if grep -qE -e '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' "$f" 2>/dev/null; then
    echo "BLOQUEADO: '$f' contiene lo que parece ser una llave privada."
    BLOCKED=1
  fi
done

if [[ "$BLOCKED" -eq 1 ]]; then
  echo ""
  echo "Commit detenido por la verificación preventiva de SEC-000.2."
  echo "Si esto es un falso positivo, revísalo con el equipo antes de forzar el commit."
  exit 1
fi

exit 0
